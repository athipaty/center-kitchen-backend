const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");

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
      }))
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

    if (!rows.length || !("TagNo" in rows[0])) {
      return res.status(400).json({
        error: "Excel must have column: TagNo",
      });
    }

    await Tag.deleteMany({});

    await Tag.insertMany(
      rows.map((r) => ({
        tagNo: String(r.TagNo).trim(),
      }))
    );

    res.json({ message: "Tag list imported", count: rows.length });
  } catch (err) {
    console.error("TAG UPLOAD ERROR:", err);
    res.status(500).json({ error: "Failed to import tag list" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const systemCount = await SystemStock.countDocuments();
    const tagCount = await Tag.countDocuments();

    res.json({
      systemStock: {
        uploaded: systemCount > 0,
        count: systemCount,
      },
      tagList: {
        uploaded: tagCount > 0,
        count: tagCount,
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch upload status" });
  }
});

module.exports = router;
