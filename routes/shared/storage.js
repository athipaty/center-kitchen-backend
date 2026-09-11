const express = require('express');
const router = express.Router();
const { getBucketUsage, b2Enabled } = require('../../utils/b2Utils');

// Reuses the same lightweight shared-password gate as routes/shared/auth.js —
// this is diagnostic info (aggregate bytes used), not a secret, but it's
// still not meant to be public.
function requireAdmin(req, res, next) {
  const password = req.query.password || req.headers['x-admin-password'];
  if (password !== (process.env.ADMIN_PASSWORD || '555')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.get('/b2-usage', requireAdmin, async (req, res) => {
  if (!b2Enabled()) {
    return res.status(400).json({ error: 'B2 is not configured (B2_KEY_ID/B2_APP_KEY/B2_BUCKET/B2_IMAGES_ENABLED)' });
  }
  try {
    const usage = await getBucketUsage();
    const gb = usage.totalBytes / 1024 ** 3;
    res.json({
      bucket: process.env.B2_BUCKET,
      fileCount: usage.fileCount,
      totalBytes: usage.totalBytes,
      totalGB: +gb.toFixed(3),
      // Backblaze's free tier is 10GB storage; informational only — this
      // backend doesn't know your actual plan/cap, if different.
      percentOfFree10GB: +((gb / 10) * 100).toFixed(2),
      byFolder: usage.byPrefix,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
