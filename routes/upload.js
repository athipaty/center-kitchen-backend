const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");
const Location = require("../models/Location");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/system-stock", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    console.log("SYSTEM ROW SAMPLE:", rows[0]);

    if (!rows.length) {
      return res.status(400).json({ error: "Excel is empty" });
    }

    if (!("PartNo" in rows[0]) || !("Qty" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have columns: PartNo, Qty",
      });
    }

    await SystemStock.deleteMany({});

    await SystemStock.insertMany(
      rows.map((r) => ({
        partNo: String(r.PartNo).trim(),
        systemQty: Number(r.Qty),
      })),
    );

    res.json({ message: "System stock imported", count: rows.length });
  } catch (err) {
    console.error("SYSTEM STOCK ERROR:", err);
    res.status(500).json({ error: "Failed to import system stock" });
  }
});

router.post("/tags", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    console.log("TAG ROW SAMPLE:", rows[0]);

    if (!rows.length || !("tagNo" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have column: tagNo",
      });
    }

    await Tag.deleteMany({});

    await Tag.insertMany(
      rows.map((r) => ({
        tagNo: String(r.tagNo).trim(),
      })),
    );

    res.json({ message: "Tag list imported", count: rows.length });
  } catch (err) {
    console.error("TAG UPLOAD ERROR:", err);
    res.status(500).json({ error: "Failed to import tag list" });
  }
});

/* =====================
   LOCATION UPLOAD
===================== */
router.post("/locations", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows.length || !("Location" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have column: Location",
      });
    }

    // Clear old locations
    await Location.deleteMany({});

    await Location.insertMany(
      rows.map((r) => ({
        location: String(r.Location).trim(),
      })),
    );

    res.json({
      message: "Location list imported",
      count: rows.length,
    });
  } catch (err) {
    console.error("LOCATION UPLOAD ERROR:", err);
    res.status(500).json({ error: "Failed to import locations" });
  }
});

/* =====================
   LOCATION SEARCH
===================== */
router.get("/locations/search", async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);

  try {
    const locations = await Location.find({
      location: { $regex: q, $options: "i" },
    })
      .limit(5)
      .select("location");

    res.json(locations.map((l) => l.location));
  } catch (err) {
    res.status(500).json({ error: "Failed to search locations" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const systemCount = await SystemStock.countDocuments();
    const tagCount = await Tag.countDocuments();
    const locationCount = await Location.countDocuments();

    res.json({
      systemStock: {
        uploaded: systemCount > 0,
        count: systemCount,
      },
      tagList: {
        uploaded: tagCount > 0,
        count: tagCount,
      },
      locationList: {
        uploaded: locationCount > 0,
        count: locationCount,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch upload status" });
  }
});

/* =====================
   PART NO SEARCH
===================== */
router.get("/parts/search", async (req, res) => {
  const { q } = req.query;

  if (!q) return res.json([]);

  try {
    const parts = await SystemStock.find({
      partNo: { $regex: q, $options: "i" },
    })
      .limit(5)
      .select("partNo");

    res.json(parts.map((p) => p.partNo));
  } catch (err) {
    res.status(500).json({ error: "Failed to search parts" });
  }
});

module.exports = router;
