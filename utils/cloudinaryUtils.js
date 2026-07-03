const { v2: cloudinary } = require('cloudinary');

function getClient() {
  return cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

async function deleteCloudinaryFolder(folder) {
  if (!folder) return;
  if (!process.env.CLOUDINARY_CLOUD_NAME) return;
  getClient();
  try {
    await cloudinary.api.delete_resources_by_prefix(folder + '/', { invalidate: true });
    // Also clear non-image resources (PDFs, Excel, etc.) — delete_resources_by_prefix
    // defaults to resource_type: 'image' and silently leaves raw files behind.
    await cloudinary.api.delete_resources_by_prefix(folder + '/', { resource_type: 'raw', invalidate: true }).catch(() => {});
    await cloudinary.api.delete_folder(folder).catch(() => {});
    console.log(`cloudinary: deleted folder ${folder}`);
  } catch (e) {
    const msg = e.message || e.http_code || e.error?.message || (typeof e === 'object' ? JSON.stringify(e).slice(0, 120) : String(e));
    console.error(`cloudinary: failed to delete folder ${folder}: ${msg}`);
  }
}

async function renameCloudinaryImage(oldPublicId, newPublicId) {
  if (!process.env.CLOUDINARY_CLOUD_NAME) return null;
  getClient();
  try {
    const result = await cloudinary.uploader.rename(oldPublicId, newPublicId, { overwrite: true });
    return result.secure_url;
  } catch (e) {
    const msg = e.message || (typeof e === 'object' ? JSON.stringify(e).slice(0, 120) : String(e));
    console.error(`cloudinary: rename ${oldPublicId} → ${newPublicId} failed: ${msg}`);
    return null;
  }
}

module.exports = { deleteCloudinaryFolder, renameCloudinaryImage };
