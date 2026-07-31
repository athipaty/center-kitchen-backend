const express = require('express');
const router = express.Router();
const ProfileAsset = require('../models/shared/ProfileAsset');

// Public read-only endpoints serving binary assets (photo, certificate) for
// the portfolio site directly out of MongoDB — cacheable, no auth needed.
router.get('/asset/:id', async (req, res) => {
  try {
    const asset = await ProfileAsset.findById(req.params.id).lean();
    if (!asset) return res.status(404).json({ error: 'Not found' });
    res.set('Content-Type', asset.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    if (asset.filename) {
      res.set('Content-Disposition', `inline; filename="${asset.filename}"`);
    }
    res.send(asset.data.buffer || asset.data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
