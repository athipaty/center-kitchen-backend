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
    await cloudinary.api.delete_folder(folder).catch(() => {});
    console.log(`cloudinary: deleted folder ${folder}`);
  } catch (e) {
    const msg = e.message || e.http_code || e.error?.message || (typeof e === 'object' ? JSON.stringify(e).slice(0, 120) : String(e));
    console.error(`cloudinary: failed to delete folder ${folder}: ${msg}`);
  }
}

module.exports = { deleteCloudinaryFolder };
