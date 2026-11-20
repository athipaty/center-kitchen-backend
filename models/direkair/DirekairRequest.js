const mongoose = require('mongoose');

// "แจ้งผู้พัฒนา": requests from the shop admin to the website's developer (text + photos),
// with a reply thread. Same idea as AbtContactMessage; the developer gets an ntfy push for
// each new request. Requests marked 'done' are deleted 14 days after their last update.
const DirekairRequestReplySchema = new mongoose.Schema({
  author:  { type: String, default: 'ผู้พัฒนาเว็บ' },
  message: { type: String, required: true },
}, { timestamps: true });

const DirekairRequestSchema = new mongoose.Schema({
  title:   { type: String, required: true },
  message: { type: String, required: true },
  pageUrl: { type: String, default: '' },
  images:  { type: [{ _id: false, url: String, key: String }], default: [] }, // B2 under direkair-requests/
  status:  { type: String, default: 'new', enum: ['new', 'read', 'done'] },
  replies: [DirekairRequestReplySchema],
}, { timestamps: true });

DirekairRequestSchema.statics.DONE_RETENTION_DAYS = 14;

module.exports = mongoose.model('DirekairRequest', DirekairRequestSchema);
