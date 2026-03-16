const express = require("express");
const router = express.Router();
const multer = require("multer");
const Papa = require("papaparse");
const XLSX = require("xlsx");
const Forecast = require("../models/Forecast");

const upload = multer({ storage: multer.memoryStorage() });

// Parse uploaded file (CSV or Excel) → array of row objects
function parseFile(buffer, mimetype, originalname) {
  const ext = originalname.split(".").pop().toLowerCase();

  let rows = [];

  if (ext === "csv") {
    const text = buffer.toString("utf8");
    const result = Papa.parse(text, { header: true, skipEmptyLines: true });
    rows = result.data;
  } else {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  }

  return rows;
}

function parseQty(v) {
  if (v === undefined || v === null || v === "" || v === "-") return 0;
  return parseFloat(String(v).replace(/,/g, "")) || 0;
}

// Normalise raw rows into our schema shape
function normaliseRows(rawRows) {
  const skip = new Set([
    "customer",
    "Customer",
    "CUSTOMER",
    "part no",
    "Part No",
    "PART NO",
    "partno",
    "part_no",
    "PartNo",
    "upload date",
    "Upload Date",
    "UPLOAD DATE",
    "uploaddate",
    "upload_date",
  ]);
  const sample = rawRows[0] || {};
  const monthKeys = Object.keys(sample).filter(
    (k) => !skip.has(k.toLowerCase().replace(/\s/g, "")),
  );

  return rawRows.map((r) => {
    const customer = r["customer"] || r["Customer"] || r["CUSTOMER"] || "";
    const partNo =
      r["part no"] || r["Part No"] || r["PART NO"] || r["part_no"] || "";
    const quantities = {};
    monthKeys.forEach((m) => {
      quantities[m] = parseQty(r[m]);
    });
    return { customer, partNo, quantities };
  });
}

// POST /api/forecast/upload
// Body: multipart — label ("previous"|"current"), file
router.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const { label } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const rawRows = parseFile(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
    );
    const rows = normaliseRows(rawRows);

    const forecast = await Forecast.create({
      label,
      filename: req.file.originalname,
      rows,
    });

    res.json({ message: "Uploaded", id: forecast._id, rowCount: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forecast/list
// Returns all uploads (id, label, filename, uploadDate, rowCount)
router.get("/list", async (req, res) => {
  try {
    const forecasts = await Forecast.find(
      {},
      { label: 1, filename: 1, uploadDate: 1, rows: { $slice: 0 } },
    ).sort({ uploadDate: -1 });

    // Return count separately
    const list = await Promise.all(
      forecasts.map(async (f) => {
        const full = await Forecast.findById(f._id);
        return {
          _id: f._id,
          label: f.label,
          filename: f.filename,
          uploadDate: f.uploadDate,
          rowCount: full.rows.length,
        };
      }),
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/forecast/compare?prevId=xxx&currId=yyy
router.get("/compare", async (req, res) => {
  try {
    const { prevId, currId } = req.query;
    if (!prevId || !currId)
      return res.status(400).json({ error: "prevId and currId required" });

    const [prev, curr] = await Promise.all([
      Forecast.findById(prevId),
      Forecast.findById(currId),
    ]);
    if (!prev || !curr)
      return res.status(404).json({ error: "Forecast not found" });

    // Collect all month keys
    const monthSet = new Set();
    [...prev.rows, ...curr.rows].forEach((r) => {
      Object.keys(
        r.quantities.toJSON ? r.quantities.toJSON() : r.quantities,
      ).forEach((m) => monthSet.add(m));
    });
    const months = [...monthSet];

    // Build lookup maps
    const prevMap = {};
    prev.rows.forEach((r) => {
      prevMap[`${r.customer}||${r.partNo}`] = r;
    });
    const currMap = {};
    curr.rows.forEach((r) => {
      currMap[`${r.customer}||${r.partNo}`] = r;
    });

    const allKeys = [
      ...new Set([...Object.keys(prevMap), ...Object.keys(currMap)]),
    ];

    const rows = allKeys.map((key) => {
      const p = prevMap[key];
      const c = currMap[key];
      const base = c || p;
      const pQty = p
        ? p.quantities.toJSON
          ? p.quantities.toJSON()
          : p.quantities
        : {};
      const cQty = c
        ? c.quantities.toJSON
          ? c.quantities.toJSON()
          : c.quantities
        : {};

      const monthData = months.map((m) => {
        const pv = pQty[m] || 0;
        const cv = cQty[m] || 0;
        const diff = cv - pv;
        const pct =
          pv === 0 ? (cv > 0 ? 100 : 0) : Math.round((diff / pv) * 100);
        return {
          month: m,
          prev: pv,
          curr: cv,
          diff,
          pct,
          alert: Math.abs(pct) >= 20 && (pv > 0 || cv > 0),
        };
      });

      return {
        customer: base.customer,
        partNo: base.partNo,
        hasAlert: monthData.some((md) => md.alert),
        monthData,
      };
    });

    res.json({
      months,
      rows,
      prevFile: prev.filename,
      currFile: curr.filename,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/forecast/:id
router.delete("/:id", async (req, res) => {
  try {
    await Forecast.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
