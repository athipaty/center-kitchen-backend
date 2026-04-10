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
  if (ext === "csv") {
    const text = buffer.toString("utf8");
    return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
  } else {
    const wb = XLSX.read(buffer, { type: "buffer" });
    return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {
      defval: "",
    });
  }
}

function parseQty(v) {
  if (!v || v === "-") return 0;
  return parseFloat(String(v).replace(/,/g, "")) || 0;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// Get week start (Monday) for a date
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

// POST /api/stock/upload-mapping
router.post("/upload-mapping", upload.single("file"), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const mapping = rows
      .map((r) => ({
        stockPartNo: (
          r["stock_part_no"] ||
          r["Stock Part No"] ||
          r["stock part no"] ||
          Object.values(r)[0] ||
          ""
        )
          .toString()
          .trim(),
        systemPartNo: (
          r["system_part_no"] ||
          r["System Part No"] ||
          r["system part no"] ||
          Object.values(r)[1] ||
          ""
        )
          .toString()
          .trim(),
      }))
      .filter((m) => m.stockPartNo && m.systemPartNo);

    // Save or update mapping
    let stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) stockData = new StockData();
    stockData.mapping = mapping;
    await stockData.save();

    res.json({
      message: "Mapping uploaded",
      count: mapping.length,
      id: stockData._id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stock/upload-stock
router.post("/upload-stock", upload.single("file"), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData)
      return res.status(400).json({ error: "Upload mapping first" });

    // Build mapping lookup
    const mapLookup = {};
    stockData.mapping.forEach(
      (m) => (mapLookup[m.stockPartNo.toLowerCase()] = m.systemPartNo),
    );

    const { type } = req.body; // 'current', 'incoming', 'po', 'forecast'

    if (type === "current") {
      stockData.currentStock = rows
        .map((r) => {
          const rawPart = (
            r["part_no"] ||
            r["part no"] ||
            r["Part No"] ||
            Object.values(r)[0] ||
            ""
          )
            .toString()
            .trim();
          const partNo = mapLookup[rawPart.toLowerCase()] || rawPart;
          return {
            partNo,
            qty: parseQty(
              r["qty"] || r["Qty"] || r["stock"] || Object.values(r)[1],
            ),
          };
        })
        .filter((r) => r.partNo && r.qty > 0);
    } else if (type === "incoming") {
      stockData.incomingStock = rows
        .map((r) => {
          const rawPart = (
            r["part_no"] ||
            r["part no"] ||
            r["Part No"] ||
            r["PART NO"] ||
            r["partno"] ||
            ""
          )
            .toString()
            .trim();
          const partNo = mapLookup[rawPart.toLowerCase()] || rawPart;
          return {
            partNo,
            invoiceNo: (
              r["invoice_no"] ||
              r["invoice no"] ||
              r["Invoice No"] ||
              r["INVOICE NO"] ||
              ""
            )
              .toString()
              .trim(),
            poNo: (r["po_no"] || r["po no"] || r["PO No"] || r["PO NO"] || "")
              .toString()
              .trim(),
            qty: parseQty(r["qty"] || r["Qty"] || r["QTY"] || ""),
            date: parseDate(
              r["eta"] ||
                r["ETA"] ||
                r["arrival_date"] ||
                r["date"] ||
                r["Date"] ||
                "",
            ),
          };
        })
        .filter((r) => r.partNo && r.qty > 0 && r.date);
    } else if (type === "po") {
      stockData.poConfirmed = rows
        .map((r) => {
          const rawPart = (
            r["part_no"] ||
            r["part no"] ||
            r["Part No"] ||
            Object.values(r)[0] ||
            ""
          )
            .toString()
            .trim();
          const partNo = mapLookup[rawPart.toLowerCase()] || rawPart;
          return {
            partNo,
            qty: parseQty(r["qty"] || r["Qty"] || Object.values(r)[1]),
            date: parseDate(r["date"] || r["Date"] || Object.values(r)[2]),
          };
        })
        .filter((r) => r.partNo && r.qty > 0 && r.date);
    } else if (type === "forecast") {
      stockData.forecast = rows
        .map((r) => {
          const rawPart = (
            r["part_no"] ||
            r["part no"] ||
            r["Part No"] ||
            Object.values(r)[0] ||
            ""
          )
            .toString()
            .trim();
          const partNo = mapLookup[rawPart.toLowerCase()] || rawPart;
          return {
            partNo,
            qty: parseQty(r["qty"] || r["Qty"] || Object.values(r)[1]),
            date: parseDate(r["date"] || r["Date"] || Object.values(r)[2]),
          };
        })
        .filter((r) => r.partNo && r.qty > 0 && r.date);
    }

    await stockData.save();
    res.json({ message: `${type} uploaded`, id: stockData._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stock/calculate
router.get("/calculate", async (req, res) => {
  try {
    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData)
      return res.status(404).json({ error: "No stock data found" });

    // Get all unique parts
    const allParts = [
      ...new Set([
        ...stockData.currentStock.map((r) => r.partNo),
        ...stockData.incomingStock.map((r) => r.partNo),
        ...stockData.poConfirmed.map((r) => r.partNo),
        ...stockData.forecast.map((r) => r.partNo),
      ]),
    ];

    // Get all unique weeks sorted
    const allDates = [
      ...stockData.incomingStock.map((r) => r.date),
      ...stockData.poConfirmed.map((r) => r.date),
      ...stockData.forecast.map((r) => r.date),
    ].filter(Boolean);

    const weekKeys = [...new Set(allDates.map((d) => weekKey(d)))].sort();

    // Build supply and demand by part + week
    const results = allParts.map((partNo) => {
      // Current stock
      const currentQty = stockData.currentStock
        .filter((r) => r.partNo === partNo)
        .reduce((s, r) => s + r.qty, 0);

      // Incoming by week
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

      // PO by week
      const poByWeek = {};
      stockData.poConfirmed
        .filter((r) => r.partNo === partNo)
        .forEach((r) => {
          const wk = weekKey(r.date);
          poByWeek[wk] = (poByWeek[wk] || 0) + r.qty;
        });

      // Forecast by week
      const forecastByWeek = {};
      stockData.forecast
        .filter((r) => r.partNo === partNo)
        .forEach((r) => {
          const wk = weekKey(r.date);
          forecastByWeek[wk] = (forecastByWeek[wk] || 0) + r.qty;
        });

      // Calculate running balance week by week
      let balance = currentQty;
      let shortageWeek = null;
      const weeks = weekKeys.map((wk) => {
        const incoming = incomingByWeek[wk] || 0;
        const incomingDetail = incomingDetailByWeek[wk] || [];
        // Use PO if exists, else forecast
        const hasPO = poByWeek[wk] !== undefined;
        const demand = hasPO ? poByWeek[wk] || 0 : forecastByWeek[wk] || 0;
        const demandType = hasPO ? "po" : "forecast";

        balance = balance + incoming - demand;

        if (balance < 0 && !shortageWeek) shortageWeek = wk;

        return {
          week: wk,
          incoming,
          demand,
          demandType,
          balance: Math.round(balance),
          shortage: balance < 0,
        };
      });

      return {
        partNo,
        currentStock: currentQty,
        shortageWeek,
        weeksUntilShortage: shortageWeek
          ? weekKeys.indexOf(shortageWeek)
          : null,
        weeks,
      };
    });

    // Sort by soonest shortage first
    results.sort((a, b) => {
      if (a.shortageWeek && b.shortageWeek)
        return a.shortageWeek.localeCompare(b.shortageWeek);
      if (a.shortageWeek) return -1;
      if (b.shortageWeek) return 1;
      return 0;
    });

    res.json({ weeks: weekKeys, parts: results });
  } catch (err) {
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
