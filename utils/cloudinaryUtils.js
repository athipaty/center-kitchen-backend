const axios = require('axios');
const crypto = require('crypto');

async function deleteCloudinaryFolder(folder) {
  if (!folder) return;
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !apiKey || !apiSecret) return;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const toSign = `invalidate=true&prefix=${folder}&timestamp=${timestamp}${apiSecret}`;
    const signature = crypto.createHash('sha1').update(toSign).digest('hex');
    await axios.delete(
      `https://api.cloudinary.com/v1_1/${cloud}/resources/image/upload`,
      { params: { prefix: folder, all: true, invalidate: true, api_key: apiKey, timestamp, signature } }
    );
    const ft = Math.floor(Date.now() / 1000);
    const fs = crypto.createHash('sha1').update(`folder=${folder}&timestamp=${ft}${apiSecret}`).digest('hex');
    await axios.delete(
      `https://api.cloudinary.com/v1_1/${cloud}/folders/${encodeURIComponent(folder)}`,
      { params: { api_key: apiKey, timestamp: ft, signature: fs } }
    ).catch(() => {});
    console.log(`cloudinary: deleted folder ${folder}`);
  } catch (e) {
    console.error(`cloudinary: failed to delete folder ${folder}:`, e.response?.data || e.message);
  }
}

module.exports = { deleteCloudinaryFolder };
