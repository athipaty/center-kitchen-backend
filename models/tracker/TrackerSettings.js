const mongoose = require('mongoose');

const TrackerSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'tracker' },
  saleModeActive: { type: Boolean, default: false },
  lastDiscoveryRun: { type: Date, default: null },
  lastDiscoveryAdded: { type: Array, default: [] },
}, { _id: false });

module.exports = mongoose.model('TrackerSettings', TrackerSettingsSchema);
