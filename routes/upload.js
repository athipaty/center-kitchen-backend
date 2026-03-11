const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");

const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");
const Location = require("../models/Location");
const ProductionPart = require("../models/ProductionPart");
const PreviousDiff = require("../models/PreviousDiff");
const PhysicalCount = require("../models/PhysicalCount");
const Catalog = require("../models/Catalog");

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

router.delete("/system-stock", async (req, res) => {
  try {
    const result = await SystemStock.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear system stock" });
  }
});

/* =====================
   TAG UPLOAD
===================== */

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

router.delete("/tags", async (req, res) => {
  try {
    const result = await Tag.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear tags" });
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

/* =====================
  PRODUCTION PARTS UPLOAD
===================== */

router.post("/production-parts", upload.single("file"), async (req, res) => {
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
      if (!partNo) {
        errors.push(`Row ${index + 2}: partNo is required`);
        return;
      }
      cleanedRows.push({ partNo });
    });

    if (errors.length > 0) {
      return res
        .status(400)
        .json({ error: "Validation failed", details: errors });
    }

    // replace all existing production parts
    await ProductionPart.deleteMany({});
    const inserted = await ProductionPart.insertMany(cleanedRows);

    res.json({ ok: true, count: inserted.length });
  } catch (err) {
    console.error("UPLOAD PRODUCTION PARTS ERROR:", err);
    res.status(500).json({ error: "Failed to upload production parts" });
  }
});

router.delete("/production-parts", async (req, res) => {
  try {
    const result = await ProductionPart.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear production parts" });
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
   UPLOAD STOCK TAKE (STRICT)
===================== */
router.post("/upload-stocktake", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // ---- read excel ----
    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

    if (!rows.length) {
      return res.status(400).json({ error: "Excel file is empty" });
    }

    const cleanedRows = [];
    const errors = [];

    rows.forEach((r, index) => {
      const rowNum = index + 2; // header = row 1

      const tagNo = String(r.tagNo || "").trim();
      const partNo = String(r.partNo || "")
        .trim()
        .toUpperCase();
      const location = String(r.location || "")
        .trim()
        .toUpperCase();

      const qtyPerBox = Number(r.qtyPerBox);
      const boxes = Number(r.boxes);
      const openBoxQty = Number(r.openBoxQty || 0);

      // ---- validation ----
      if (!tagNo || !partNo || !location) {
        errors.push(`Row ${rowNum}: tagNo, partNo, location are required`);
        return;
      }

      if ([qtyPerBox, boxes, openBoxQty].some((n) => Number.isNaN(n))) {
        errors.push(
          `Row ${rowNum}: qtyPerBox, boxes, openBoxQty must be numbers`,
        );
        return;
      }

      if (qtyPerBox < 0 || boxes < 0 || openBoxQty < 0) {
        errors.push(`Row ${rowNum}: values cannot be negative`);
        return;
      }

      if (!Number.isInteger(boxes)) {
        errors.push(`Row ${rowNum}: boxes must be an integer`);
        return;
      }

      const totalQty = qtyPerBox * boxes + openBoxQty;

      cleanedRows.push({
        tagNo,
        partNo,
        location,
        qtyPerBox,
        boxes,
        openBoxQty,
        totalQty,
      });
    });

    // ---- reject entire upload if ANY error ----
    if (errors.length > 0) {
      return res.status(400).json({
        error: "Validation failed",
        details: errors,
      });
    }

    // ---- merge duplicate partNo + location within Excel rows ----
    const mergeMap = new Map();

    cleanedRows.forEach((r) => {
      const key = `${r.partNo}||${r.location}`;
      if (mergeMap.has(key)) {
        const existing = mergeMap.get(key);
        existing.boxes += r.boxes;
        existing.openBoxQty += r.openBoxQty;
        existing.totalQty += r.totalQty;
      } else {
        mergeMap.set(key, { ...r });
      }
    });

    const mergedRows = Array.from(mergeMap.values());

    // ---- STRICT stock take ----
    const deleted = await PhysicalCount.countDocuments();
    await PhysicalCount.deleteMany({});

    const insertedDocs = await PhysicalCount.insertMany(cleanedRows);

    res.json({
      ok: true,
      inserted: insertedDocs.length,
      deleted,
    });
  } catch (err) {
    console.error("UPLOAD STOCKTAKE ERROR:", err.message);
    console.error("FULL ERROR:", err);
    res
      .status(500)
      .json({ error: err.message || "Failed to upload stock take" });
  }
});

router.delete("/upload-stocktake", async (req, res) => {
  try {
    const result = await PhysicalCount.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: "Failed to clear count data" });
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

/* =====================
   Product Catalog Upload
===================== */

router.post("/catalog", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });  // ← XLSX not xlsx
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });     // ← XLSX not xlsx

    if (!rows.length) return res.status(400).json({ message: "File is empty" });

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [] };

    for (const row of rows) {
      const partNo = String(row["partNo"] || "").trim();
      if (!partNo) { results.skipped++; continue; }

      const doc = {
        partNo,
        name:           String(row["name"] || "").trim(),
        customer:       String(row["customer"] || "").trim(),
        supplier:       String(row["supplier"] || "").trim(),
        category:       String(row["category"] || "").trim(),
        type:           String(row["type"] || "").trim(),
        volumePerMonth: row["volumePerMonth"] ? Number(row["volumePerMonth"]) : undefined,
        spec: {
          material:         String(row["material"] || "").trim(),
          heatTreatment:    String(row["heatTreatment"] || "").trim(),
          surfaceTreatment: String(row["surfaceTreatment"] || "").trim(),
          headType:         String(row["headType"] || "").trim(),
          driveType:        String(row["driveType"] || "").trim(),
          threadSize:       String(row["threadSize"] || "").trim(),
          length:           row["length"] ? Number(row["length"]) : undefined,
          outerDiameter:    String(row["outerDiameter"] || "").trim(),
          innerDiameter:    String(row["innerDiameter"] || "").trim(),
          thickness:        row["thickness"] ? Number(row["thickness"]) : undefined,
          standard:         String(row["standard"] || "").trim(),
          grade:            String(row["grade"] || "").trim(),
          note:             String(row["note"] || "").trim(),
        },
      };

      try {
        const existing = await Catalog.findOne({ partNo });
        if (existing) {
          await Catalog.updateOne({ partNo }, { $set: doc });
          results.updated++;
        } else {
          await Catalog.create(doc);
          results.inserted++;
        }
      } catch (err) {
        results.errors.push({ partNo, error: err.message });
      }
    }

    res.json({
      message: "Upload complete",
      total: rows.length,
      ...results,
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
