const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const router = express.Router();
const { uploadToB2 } = require("../../utils/b2Utils");
const { requireMarketAuth } = require("../../utils/marketAuth");

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WEBP, or GIF images are allowed"));
    }
    cb(null, true);
  },
});

router.post("/", requireMarketAuth, upload.array("images", 6), async (req, res) => {
  try {
    const files = req.files || [];
    const urls = await Promise.all(
      files.map((file) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const fileKey = `market-listings/${Date.now()}-${crypto.randomUUID()}${ext}`;
        return uploadToB2(file.buffer, fileKey, file.mimetype);
      })
    );
    res.status(201).json({ urls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
