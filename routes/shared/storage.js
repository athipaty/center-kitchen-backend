const express = require('express');
const mongoose = require('mongoose');
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

router.get('/mongo-usage', requireAdmin, async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const stats = await db.command({ dbStats: 1, scale: 1 });

    // Per-collection breakdown (storage + index size), so usage across the
    // many unrelated projects sharing this one database is visible — mirrors
    // the byFolder breakdown in /b2-usage. $collStats is used instead of the
    // older collStats command since it works consistently across MongoDB
    // server versions including Atlas.
    const collections = await db.listCollections().toArray();
    const perCollection = [];
    for (const c of collections) {
      try {
        const [collStats] = await db.collection(c.name).aggregate([{ $collStats: { storageStats: {} } }]).toArray();
        const s = collStats?.storageStats || {};
        perCollection.push({
          collection: c.name,
          documents: s.count || 0,
          storageBytes: (s.size || 0) + (s.totalIndexSize || 0),
        });
      } catch {
        // views and a few collection types don't support $collStats — skip them
      }
    }
    perCollection.sort((a, b) => b.storageBytes - a.storageBytes);

    const totalBytes = (stats.storageSize || 0) + (stats.indexSize || 0);
    const totalGB = totalBytes / 1024 ** 3;

    const result = {
      database: stats.db,
      collectionCount: stats.collections,
      documentCount: stats.objects,
      totalBytes,
      totalGB: +totalGB.toFixed(4),
      topCollectionsByStorage: perCollection.slice(0, 15),
    };

    // Atlas exposes actual host-level disk usage (shared across every
    // database on that cluster, not just this connection's db) — far more
    // accurate than guessing a plan cap when available.
    if (typeof stats.fsUsedSize === 'number' && typeof stats.fsTotalSize === 'number') {
      result.fsUsedBytes = stats.fsUsedSize;
      result.fsTotalBytes = stats.fsTotalSize;
      result.percentOfClusterDisk = +((stats.fsUsedSize / stats.fsTotalSize) * 100).toFixed(2);
    } else {
      // No fs-level stats (self-hosted, or a driver/version that doesn't
      // expose them) — fall back to an assumed Atlas M0 free-tier cap
      // (512MB) as a rough estimate only.
      result.percentOfFree512MB = +((totalGB * 1024 / 512) * 100).toFixed(2);
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
