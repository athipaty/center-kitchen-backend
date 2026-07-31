const mongoose = require('mongoose');

// Small binary assets (photo, certificate PDF) for the public portfolio site,
// stored directly in Mongo rather than as static files in the profile repo.
const ProfileAssetSchema = new mongoose.Schema({
  _id: { type: String }, // e.g. 'avatar', 'certificate-cu-00149'
  data: { type: Buffer, required: true },
  contentType: { type: String, required: true },
  filename: { type: String, default: null },
}, { _id: false, timestamps: true });

module.exports = mongoose.model('ProfileAsset', ProfileAssetSchema);
