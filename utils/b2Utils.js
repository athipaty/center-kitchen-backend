const axios = require('axios');
const crypto = require('crypto');

let _auth = null;

async function getAuth() {
  if (_auth && Date.now() < _auth.expiresAt) return _auth;
  const cred = Buffer.from(`${process.env.B2_KEY_ID}:${process.env.B2_APP_KEY}`).toString('base64');
  const { data } = await axios.get('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: `Basic ${cred}` },
    timeout: 10000,
  });
  _auth = {
    apiUrl:      data.apiInfo.storageApi.apiUrl,
    authToken:   data.authorizationToken,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    bucketId:    data.apiInfo.storageApi.bucketId,
    expiresAt:   Date.now() + 23 * 3600 * 1000,
  };
  return _auth;
}

// Returns the public HTTPS URL for a file key in the images bucket.
// Routes through the Cloudflare-fronted CDN host (B2_CDN_HOST) when configured,
// which gets edge-cached and qualifies for Backblaze's Bandwidth Alliance free
// egress; falls back to hitting B2 directly otherwise.
function b2PublicUrl(fileKey) {
  const bucket = process.env.B2_BUCKET; // maesai-pdfs
  if (process.env.B2_CDN_HOST) {
    return `https://${process.env.B2_CDN_HOST}/file/${bucket}/${fileKey}`;
  }
  // downloadUrl is e.g. https://f004.backblazeb2.com
  const base = (_auth?.downloadUrl) || 'https://f004.backblazeb2.com';
  return `${base}/file/${bucket}/${fileKey}`;
}

// Upload a Buffer to B2, returns the public URL. `cacheControl` defaults to a
// forever-cache since every caller uses a fileKey that's never overwritten
// with different content once uploaded.
async function uploadToB2(buffer, fileKey, contentType = 'image/jpeg', cacheControl = 'public, max-age=31536000, immutable') {
  const b2 = await getAuth();

  // Each upload needs a fresh one-time upload URL
  const { data: upData } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_get_upload_url`,
    { bucketId: b2.bucketId },
    { headers: { Authorization: b2.authToken }, timeout: 10000 }
  );

  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
  // B2 requires forward slashes preserved, other chars URL-encoded
  const encodedName = fileKey.split('/').map(encodeURIComponent).join('/');

  await axios.post(upData.uploadUrl, buffer, {
    headers: {
      Authorization:      upData.authorizationToken,
      'X-Bz-File-Name':   encodedName,
      'Content-Type':     contentType,
      'Content-Length':   buffer.length,
      'X-Bz-Content-Sha1': sha1,
      // B2 echoes X-Bz-Info-Cache-Control back as the Cache-Control response
      // header on download, so this controls actual browser caching behavior.
      'X-Bz-Info-Cache-Control': encodeURIComponent(cacheControl),
    },
    // This function uploads everything from tiny sprite/audio images up to full rendered
    // episode videos (youtubeEpisodeScheduler's stepRender uploads the final mp4 here) — a
    // hardcoded 20MB cap and 30s timeout sized for images made every video upload fail with
    // axios's own "Request body larger than maxBodyLength limit" before the request even went
    // out. No artificial cap; B2's own per-file limits are the real constraint. Timeout is
    // generous specifically for large video uploads over a normal connection.
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 10 * 60 * 1000,
  });

  return b2PublicUrl(fileKey);
}

// Server-side copy within B2 (no download bandwidth cost), returns new public URL
async function copyB2File(sourceFileKey, destFileKey) {
  const b2 = await getAuth();

  // Need the fileId of the source — list to find it
  const { data: listData } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_list_file_names`,
    { bucketId: b2.bucketId, prefix: sourceFileKey, maxFileCount: 1 },
    { headers: { Authorization: b2.authToken }, timeout: 10000 }
  );
  const sourceFile = listData.files?.[0];
  if (!sourceFile || sourceFile.fileName !== sourceFileKey) {
    throw new Error(`b2: source file not found: ${sourceFileKey}`);
  }

  const encodedDest = destFileKey.split('/').map(encodeURIComponent).join('/');
  const { data: copied } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_copy_file`,
    { sourceFileId: sourceFile.fileId, fileName: encodedDest },
    { headers: { Authorization: b2.authToken }, timeout: 15000 }
  );

  return b2PublicUrl(destFileKey);
}

// Delete all files under a prefix (mirrors deleteCloudinaryFolder)
async function deleteB2Prefix(prefix) {
  if (!prefix || !process.env.B2_KEY_ID) return;
  try {
    const b2 = await getAuth();
    let nextFileName = undefined;
    let deleted = 0;

    while (true) {
      const body = { bucketId: b2.bucketId, prefix, maxFileCount: 1000 };
      if (nextFileName) body.startFileName = nextFileName;
      const { data } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_list_file_names`,
        body, { headers: { Authorization: b2.authToken }, timeout: 15000 }
      );
      const files = data.files || [];
      if (!files.length) break;

      for (const f of files) {
        await axios.post(`${b2.apiUrl}/b2api/v3/b2_delete_file_version`,
          { fileId: f.fileId, fileName: f.fileName },
          { headers: { Authorization: b2.authToken }, timeout: 10000 }
        ).catch(() => {});
        deleted++;
      }

      if (data.nextFileName) { nextFileName = data.nextFileName; } else { break; }
    }

    if (deleted) console.log(`b2: deleted ${deleted} files under ${prefix}`);
  } catch (e) {
    console.error(`b2: failed to delete prefix ${prefix}:`, e.message);
  }
}

// Delete exactly one file by its full key (not a prefix — deleteB2Prefix would also catch any
// other file whose name happens to start with the same string, which matters for something like
// sprite regeneration where only one specific version should go).
async function deleteB2File(fileKey) {
  if (!fileKey || !process.env.B2_KEY_ID) return;
  try {
    const b2 = await getAuth();
    const { data } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_list_file_names`,
      { bucketId: b2.bucketId, prefix: fileKey, maxFileCount: 1 },
      { headers: { Authorization: b2.authToken }, timeout: 10000 }
    );
    const file = data.files?.[0];
    if (!file || file.fileName !== fileKey) return; // nothing exactly matching — nothing to do
    await axios.post(`${b2.apiUrl}/b2api/v3/b2_delete_file_version`,
      { fileId: file.fileId, fileName: file.fileName },
      { headers: { Authorization: b2.authToken }, timeout: 10000 }
    );
  } catch (e) {
    console.warn(`b2: failed to delete file ${fileKey}:`, e.message);
  }
}

// Converts a public B2/CDN URL (either the CDN host or the raw f0xx.backblazeb2.com host) back to
// the bucket-relative file key uploadToB2/deleteB2File expect.
function b2KeyFromUrl(url) {
  return String(url || '').replace(/^https?:\/\/[^/]+\/file\/[^/]+\//, '');
}

// List public URLs for all files under a prefix (for checking existing uploads)
async function listB2Files(prefix) {
  const b2 = await getAuth();
  const { data } = await axios.post(`${b2.apiUrl}/b2api/v3/b2_list_file_names`,
    { bucketId: b2.bucketId, prefix, maxFileCount: 50 },
    { headers: { Authorization: b2.authToken }, timeout: 10000 }
  );
  return (data.files || []).map(f => b2PublicUrl(f.fileName));
}

// Check if B2 image storage is configured
function b2Enabled() {
  return !!(process.env.B2_KEY_ID && process.env.B2_APP_KEY && process.env.B2_BUCKET && process.env.B2_IMAGES_ENABLED === 'true');
}

module.exports = { uploadToB2, copyB2File, deleteB2Prefix, deleteB2File, b2KeyFromUrl, listB2Files, b2PublicUrl, b2Enabled };
