const express = require("express");
const router = express.Router();
const multer = require("multer");
const Papa = require("papaparse");
const XLSX = require("xlsx");
const StockData = require("../models/StockData");

const upload = multer({ storage: multer.memoryStorage() });

// Parse file helper
function parseFile(buffer, originalname) {
  const ext = originalname.split(".").pop().toLowerCase();
  let rows = [];
  if (ext === "csv") {
    const text = buffer.toString("utf8");
    rows = Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  } else {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      defval: "",
      raw: false,
    });
  }
  return rows.map((row) => {
    const cleaned = {};
    Object.keys(row).forEach((k) => {
      cleaned[k.trim()] = typeof row[k] === "string" ? row[k].trim() : row[k];
    });
    return cleaned;
  });
}

function parseQty(v) {
  if (!v || v === "-") return 0;
  return parseFloat(String(v).replace(/,/g, "")) || 0;
}

function parseDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === "number") {
    const excelDate = new Date((v - 25569) * 86400 * 1000);
    return isNaN(excelDate) ? null : excelDate;
  }
  const str = String(v).trim();
  if (!str) return null;

  if (/^\d{5}$/.test(str)) {
    const excelDate = new Date((parseInt(str) - 25569) * 86400 * 1000);
    return isNaN(excelDate) ? null : excelDate;
  }

  const yymmdd = str.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (yymmdd) {
    const [, yy, mm, dd] = yymmdd;
    const result = new Date(`20${yy}-${mm}-${dd}`);
    return isNaN(result) ? null : result;
  }

  const yymmddSlash = str.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (yymmddSlash) {
    const [, yy, mm, dd] = yymmddSlash;
    const result = new Date(`20${yy}-${mm}-${dd}`);
    return isNaN(result) ? null : result;
  }

  const yyyymmdd = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyymmdd) {
    const result = new Date(str);
    return isNaN(result) ? null : result;
  }

  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const result = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
    return isNaN(result) ? null : result;
  }

  const ddmmyyyy2 = str.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy2) {
    const [, dd, mm, yyyy] = ddmmyyyy2;
    const result = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
    return isNaN(result) ? null : result;
  }

  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function getWeekStart(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekKey(date) {
  const d = getWeekStart(date);
  return d.toISOString().split("T")[0];
}

// Clean part number — remove commas, hidden chars, lowercase
function cleanPartNo(str) {
  return str.toString().trim()
    .replace(/,/g, "")
    .replace(/\u00A0/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();
}

// Build map lookup from stockData
function buildMapLookup(stockData) {
  const mapLookup = {};
  stockData.mapping.forEach((m) => {
    if (m.stockPartNo && m.systemPartNo) {
      mapLookup[cleanPartNo(m.stockPartNo)] = m.systemPartNo.trim();
    }
  });
  return mapLookup;
}

// Get system part no from raw value using mapping
function getPartNoFromRaw(raw, mapLookup) {
  const cleaned = raw.toString().trim()
    .replace(/,/g, "")
    .replace(/\u00A0/g, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "");
  return mapLookup[cleanPartNo(cleaned)] || cleaned;
}

// POST /api/stock/upload-mapping
router.post("/upload-mapping", upload.single("file"), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const mapping = rows
      .filter((r) => r && typeof r === "object")
      .map((r) => ({
        stockPartNo: (
          r["stock_part_no"] || r["Stock Part No"] || r["stock part no"] ||
          Object.values(r)[0] || ""
        ).toString().trim(),
        systemPartNo: (
          r["system_part_no"] || r["System Part No"] || r["system part no"] ||
          Object.values(r)[1] || ""
        ).toString().trim(),
      }))
      .filter((m) => m.stockPartNo && m.systemPartNo);

    console.log(`Mapping uploaded: ${mapping.length} entries`);

    let stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) stockData = new StockData();
    stockData.mapping = mapping;
    await stockData.save();

    res.json({ message: "Mapping uploaded", count: mapping.length, id: stockData._id });
  } catch (err) {
    console.error("Mapping upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/upload-exclusions
router.post("/upload-exclusions", upload.single("file"), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) return res.status(400).json({ error: "Upload mapping first" });

    const mapLookup = buildMapLookup(stockData);

    const excluded = rows
      .filter((r) => r && typeof r === "object")
      .map((r) => {
        const raw = (
          r["part_no"] || r["part no"] || r["Part No"] ||
          r["PART NO"] || r["partno"] || Object.values(r)[0] || ""
        ).toString().trim().replace(/,/g, "");
        const partNo = getPartNoFromRaw(raw, mapLookup);
        return { partNo };
      })
      .filter((r) => r.partNo);

    console.log(`Exclusions uploaded: ${excluded.length} parts`);
    console.log("Sample excluded:", JSON.stringify(excluded.slice(0, 3)));

    stockData.excludedParts = excluded;
    stockData.markModified("excludedParts");
    await stockData.save();

    res.json({ message: "Exclusions uploaded", count: excluded.length });
  } catch (err) {
    console.error("Exclusion upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/upload-stock
router.post("/upload-stock", upload.single("file"), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const { type } = req.body;

    console.log(`Upload type: ${type}, rows: ${rows.length}`);
    console.log("Sample row:", JSON.stringify(rows[0]));

    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) return res.status(400).json({ error: "Upload mapping first" });

    const mapLookup = buildMapLookup(stockData);
    console.log(`Mapping lookup has ${Object.keys(mapLookup).length} entries`);

    function getPartNo(r) {
      const raw = (
        r["part_no"] || r["part no"] || r["Part No"] ||
        r["PART NO"] || r["PartNo"] || r["partno"] || ""
      ).toString();
      return getPartNoFromRaw(raw, mapLookup);
    }

    if (type === "current") {
      console.log("Current stock columns:", Object.keys(rows[0]));
      stockData.currentStock = rows
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          partNo: getPartNo(r),
          qty: parseQty(r["qty"] || r["Qty"] || r["QTY"] || r["stock"] || r["Stock"] || ""),
        }))
        .filter((r) => r.partNo && r.qty > 0);
      console.log("Current stock saved:", stockData.currentStock.length);

    } else if (type === "incoming") {
      stockData.incomingStock = rows
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          partNo: getPartNo(r),
          invoiceNo: (r["invoice_no"] || r["invoice no"] || r["Invoice No"] || r["INVOICE NO"] || "").toString().trim(),
          poNo: (r["po_no"] || r["po no"] || r["PO No"] || r["PO NO"] || "").toString().trim(),
          qty: parseQty(r["qty"] || r["Qty"] || r["QTY"] || ""),
          date: parseDate(r["eta"] || r["ETA"] || r["date"] || r["Date"] || r["DATE"] || ""),
        }))
        .filter((r) => r.partNo && r.qty > 0 && r.date);
      console.log("Incoming stock saved:", stockData.incomingStock.length);

    } else if (type === "po") {
      console.log("PO sample row:", JSON.stringify(rows[0]));
      console.log("PO all column keys:", Object.keys(rows[0]));

      const mapped = rows
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          customer: (r["customer"] || r["Customer"] || r["CUSTOMER"] || "").toString().trim(),
          partNo: getPartNo(r),
          qty: parseQty(r["qty"] || r["Qty"] || r["QTY"] || ""),
          date: parseDate(
            r["delivery_date"] || r["Delivery Date"] || r["delivery date"] ||
            r["date"] || r["Date"] || r["DATE"] || ""
          ),
        }));

      console.log("PO before filter:", mapped.length);
      const filtered = mapped.filter((r) => r.partNo && r.qty > 0 && r.date);
      console.log("PO after filter:", filtered.length);

      const rejected = mapped.filter((r) => !r.partNo || !r.qty || !r.date);
      if (rejected.length > 0) {
        console.log("PO rejected sample:", JSON.stringify(rejected.slice(0, 3)));
      }

      stockData.poConfirmed = filtered;

    } else if (type === "forecast") {
      stockData.forecast = rows
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
          customer: (r["customer"] || r["Customer"] || r["CUSTOMER"] || "").toString().trim(),
          partNo: getPartNo(r),
          qty: parseQty(r["qty"] || r["Qty"] || r["QTY"] || ""),
          date: parseDate(
            r["delivery_date"] || r["Delivery Date"] || r["delivery date"] ||
            r["date"] || r["Date"] || r["DATE"] || ""
          ),
        }))
        .filter((r) => r.partNo && r.qty > 0 && r.date);
      console.log("Forecast saved:", stockData.forecast.length);
    }

    stockData.markModified(
      type === "current" ? "currentStock" :
      type === "incoming" ? "incomingStock" :
      type === "po" ? "poConfirmed" : "forecast"
    );
    await stockData.save();
    res.json({ message: `${type} uploaded`, id: stockData._id });

  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/calculate
router.get("/calculate", async (req, res) => {
  try {
    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) return res.status(404).json({ error: "No stock data found" });

    // Build exclusion set
    const excludedSet = new Set(
      (stockData.excludedParts || []).map((r) => r.partNo)
    );
    console.log(`Excluded parts: ${excludedSet.size}`);

    const allParts = [
      ...new Set([
        ...stockData.currentStock.map((r) => r.partNo),
        ...stockData.incomingStock.map((r) => r.partNo),
        ...stockData.poConfirmed.map((r) => r.partNo),
        ...stockData.forecast.map((r) => r.partNo),
      ]),
    ].filter((p) => !excludedSet.has(p));

    console.log(`Total parts after exclusion: ${allParts.length}`);

    const allDates = [
      ...stockData.incomingStock.map((r) => r.date),
      ...stockData.poConfirmed.map((r) => r.date),
      ...stockData.forecast.map((r) => r.date),
    ].filter(Boolean);

    const weekKeys = [...new Set(allDates.map((d) => weekKey(d)))].sort();

    const results = allParts.map((partNo) => {
      const currentQty = stockData.currentStock
        .filter((r) => r.partNo === partNo)
        .reduce((s, r) => s + r.qty, 0);

      const incomingByWeek = {};
      const incomingDetailByWeek = {};
      stockData.incomingStock
        .filter((r) => r.partNo === partNo)
        .forEach((r) => {
          const wk = weekKey(r.date);
          incomingByWeek[wk] = (incomingByWeek[wk] || 0) + r.qty;
          if (!incomingDetailByWeek[wk]) incomingDetailByWeek[wk] = [];
          incomingDetailByWeek[wk].push({
            invoiceNo: r.invoiceNo,
            poNo: r.poNo,
            qty: r.qty,
            date: r.date,
          });
        });

      const poByWeek = {};
      const poDetailByWeek = {};
      stockData.poConfirmed
        .filter((r) => r.partNo === partNo)
        .forEach((r) => {
          const wk = weekKey(r.date);
          poByWeek[wk] = (poByWeek[wk] || 0) + r.qty;
          if (!poDetailByWeek[wk]) poDetailByWeek[wk] = [];
          poDetailByWeek[wk].push({
            customer: r.customer,
            qty: r.qty,
            date: r.date,
          });
        });

      const forecastByWeek = {};
      stockData.forecast
        .filter((r) => r.partNo === partNo)
        .forEach((r) => {
          const wk = weekKey(r.date);
          forecastByWeek[wk] = (forecastByWeek[wk] || 0) + r.qty;
        });

      let balance = currentQty;
      let shortageWeek = null;

      const poWeeks = Object.keys(poByWeek).sort();
      const lastPoWeek = poWeeks.length > 0 ? poWeeks[poWeeks.length - 1] : null;

      const weeks = weekKeys.map((wk) => {
        const incoming = incomingByWeek[wk] || 0;
        const incomingDetail = incomingDetailByWeek[wk] || [];
        const hasPO = poByWeek[wk] !== undefined;

        let demand = 0;
        let demandType = "none";

        if (hasPO) {
          demand = poByWeek[wk] || 0;
          demandType = "po";
        } else if (lastPoWeek && wk <= lastPoWeek) {
          demand = 0;
          demandType = "none";
        } else {
          demand = forecastByWeek[wk] || 0;
          demandType = demand > 0 ? "forecast" : "none";
        }

        balance = balance + incoming - demand;
        if (balance < 0 && !shortageWeek) shortageWeek = wk;

        return {
          week: wk,
          incoming,
          incomingDetail,
          demand,
          demandType,
          poDetail: poDetailByWeek[wk] || [],
          balance: Math.round(balance),
          shortage: balance < 0,
        };
      });

      return {
        partNo,
        currentStock: currentQty,
        shortageWeek,
        weeksUntilShortage: shortageWeek ? weekKeys.indexOf(shortageWeek) : null,
        weeks,
      };
    });

    results.sort((a, b) => {
      if (a.shortageWeek && b.shortageWeek) return a.shortageWeek.localeCompare(b.shortageWeek);
      if (a.shortageWeek) return -1;
      if (b.shortageWeek) return 1;
      return 0;
    });

    res.json({ weeks: weekKeys, parts: results });
  } catch (err) {
    console.error("Calculate error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/status
router.get("/status", async (req, res) => {
  try {
    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) return res.json({ hasData: false });
    res.json({
      hasData: true,
      mapping: stockData.mapping.length,
      currentStock: stockData.currentStock.length,
      incomingStock: stockData.incomingStock.length,
      poConfirmed: stockData.poConfirmed.length,
      forecast: stockData.forecast.length,
      excludedParts: (stockData.excludedParts || []).length,
      uploadDate: stockData.uploadDate,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/stock/clear
router.delete("/clear", async (req, res) => {
  try {
    await StockData.deleteMany({});
    res.json({ message: "Cleared" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;