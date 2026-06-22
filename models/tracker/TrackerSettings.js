const mongoose = require('mongoose');

const TrackerSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'tracker' },
  lastDiscoveryRun: { type: Date, default: null },
  lastDiscoveryAdded: { type: Array, default: [] },
}, { _id: false });

module.exports = mongoose.model('TrackerSettings', TrackerSettingsSchema);
