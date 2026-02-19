const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/* =====================
   SYSTEM STOCK UPLOAD
===================== */
router.post("/system-stock", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    // Validate layout
    if (!rows[0]?.PartNo || rows[0]?.Qty === undefined) {
      return res.status(400).json({
        error: "Excel must have columns: PartNo, Qty",
      });
    }

    // Clear old system stock (new stock take)
    await SystemStock.deleteMany({});

    const data = rows.map((r) => ({
      partNo: String(r.PartNo).trim(),
      systemQty: Number(r.Qty),
    }));

    await SystemStock.insertMany(data);

    res.json({
      message: "System stock imported",
      count: data.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to import system stock" });
  }
});

/* =====================
   TAG LIST UPLOAD
===================== */
router.post("/tags", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    if (!rows[0]?.TagNo) {
      return res.status(400).json({
        error: "Excel must have column: TagNo",
      });
    }

    // Clear old tags
    await Tag.deleteMany({});

    const data = rows.map((r) => ({
      tagNo: String(r.TagNo).trim(),
    }));

    await Tag.insertMany(data);

    res.json({
      message: "Tag list imported",
      count: data.length,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to import tag list" });
  }
});

module.exports = router;
