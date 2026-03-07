const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");
const Location = require("../models/Location");
const ProductionPart = require("../models/ProductionPart");
const PreviousDiff = require("../models/PreviousDiff");

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

    if (!("partNo" in rows[0]) || !("qty" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have columns: partNo, qty",
      });
    }
    await SystemStock.deleteMany({});

    await SystemStock.insertMany(
      rows.map((r) => ({
        partNo: String(r.partNo).trim(),
        systemQty: Number(r.qty),
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

    if (!rows.length || !("location" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have column: location",
      });
    }

    // Clear old locations
    await Location.deleteMany({});

    await Location.insertMany(
      rows.map((r) => ({
        location: String(r.location).trim(),
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

router.delete("/locations", async (req, res) => {
  try {
    const result = await Location.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear locations" });
  }
});


/* =====================
  PREVIOUS DIFF UPLOAD
===================== */

router.post("/previous-diff", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows.length)
      return res.status(400).json({ error: "Excel file is empty" });

    const errors = [];
    const cleanedRows = [];

    rows.forEach((r, index) => {
      const row = Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k.trim().toLowerCase(), v]),
      );

      const partNo = String(row.partno || "")
        .trim()
        .toUpperCase();
      const price = Number(row.price ?? 0);
      const diffN1 = Number(row.diffn1 ?? 0);
      const diffN2 = Number(row.diffn2 ?? 0);

      if (!partNo) {
        errors.push(`Row ${index + 2}: partNo is required`);
        return;
      }

      if (Number.isNaN(price) || Number.isNaN(diffN1) || Number.isNaN(diffN2)) {
        errors.push(
          `Row ${index + 2}: price, diffN1 and diffN2 must be numbers`,
        );
        return;
      }

      cleanedRows.push({ partNo, price, diffN1, diffN2 });
    });

    if (errors.length > 0) {
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });
    }

    await PreviousDiff.deleteMany({});
    const inserted = await PreviousDiff.insertMany(cleanedRows);

    res.json({ ok: true, count: inserted.length });
  } catch (err) {
    console.error("UPLOAD PREVIOUS DIFF ERROR:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to upload previous diff" });
  }
});

router.delete("/previous-diff", async (req, res) => {
  try {
    const result = await PreviousDiff.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear previous diff data" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const systemCount = await SystemStock.countDocuments();
    const tagCount = await Tag.countDocuments();
    const locationCount = await Location.countDocuments();
    const productionCount = await ProductionPart.countDocuments();
    const prevDiffCount = await PreviousDiff.countDocuments();

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
      productionParts: {
        uploaded: productionCount > 0,
        count: productionCount,
      }, // ✅
      previousDiff: {
        uploaded: prevDiffCount > 0,
        count: prevDiffCount,
      }, // ✅
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: err.message || "Failed to get upload status" });
    console.log("UPLOAD STATUS ERROR:", err.message);
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
