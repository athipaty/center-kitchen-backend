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
  const str = String(v).trim();
  console.log("parseDate input:", str);

  // Handle YY-MM-DD format e.g. 26-03-30
  const yymmdd = str.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (yymmdd) {
    const [, yy, mm, dd] = yymmdd;
    const result = new Date(`20${yy}-${mm}-${dd}`);
    console.log("parseDate YY-MM-DD result:", result);
    return isNaN(result) ? null : result;
  }

  // Handle YY/MM/DD format
  const yymmddSlash = str.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (yymmddSlash) {
    const [, yy, mm, dd] = yymmddSlash;
    const result = new Date(`20${yy}-${mm}-${dd}`);
    console.log("parseDate YY/MM/DD result:", result);
    return isNaN(result) ? null : result;
  }

  // Handle DD/MM/YYYY
  const ddmmyyyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const result = new Date(
      `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`,
    );
    console.log("parseDate DD/MM/YYYY result:", result);
    return isNaN(result) ? null : result;
  }

  // Excel serial number
  if (!isNaN(str) && str.length > 3) {
    const excelDate = new Date((parseInt(str) - 25569) * 86400 * 1000);
    if (!isNaN(excelDate)) {
      console.log("parseDate Excel serial result:", excelDate);
      return excelDate;
    }
  }

  const d = new Date(str);
  console.log("parseDate fallback result:", d);
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
router.post('/upload-stock', upload.single('file'), async (req, res) => {
  try {
    const rows = parseFile(req.file.buffer, req.file.originalname);
    const { type } = req.body;

    console.log(`Upload type: ${type}, rows: ${rows.length}`);
    console.log('Sample row:', JSON.stringify(rows[0]));

    const stockData = await StockData.findOne().sort({ uploadDate: -1 });
    if (!stockData) return res.status(400).json({ error: 'Upload mapping first' });

    // Build mapping lookup
    const mapLookup = {};
    stockData.mapping.forEach(m => {
      if (m.stockPartNo && m.systemPartNo) {
        mapLookup[m.stockPartNo.toLowerCase().trim()] = m.systemPartNo.trim();
      }
    });

    function getPartNo(r) {
      const raw = (
        r['part_no'] || r['part no'] || r['Part No'] ||
        r['PART NO'] || r['PartNo'] || r['partno'] || ''
      ).toString().trim();
      return mapLookup[raw.toLowerCase()] || raw;
    }

    if (type === 'current') {
      stockData.currentStock = rows
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          partNo: getPartNo(r),
          qty: parseQty(r['qty'] || r['Qty'] || r['QTY'] || r['stock'] || r['Stock'] || ''),
        }))
        .filter(r => r.partNo && r.qty > 0);
      console.log('Current stock saved:', stockData.currentStock.length);

    } else if (type === 'incoming') {
      stockData.incomingStock = rows
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          partNo: getPartNo(r),
          invoiceNo: (r['invoice_no'] || r['invoice no'] || r['Invoice No'] || r['INVOICE NO'] || '').toString().trim(),
          poNo: (r['po_no'] || r['po no'] || r['PO No'] || r['PO NO'] || '').toString().trim(),
          qty: parseQty(r['qty'] || r['Qty'] || r['QTY'] || ''),
          date: parseDate(r['eta'] || r['ETA'] || r['date'] || r['Date'] || r['DATE'] || ''),
        }))
        .filter(r => r.partNo && r.qty > 0 && r.date);
      console.log('Incoming stock saved:', stockData.incomingStock.length);

    } else if (type === 'po') {
      stockData.poConfirmed = rows
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          customer: (r['customer'] || r['Customer'] || r['CUSTOMER'] || '').toString().trim(),
          partNo: getPartNo(r),
          qty: parseQty(r['qty'] || r['Qty'] || r['QTY'] || ''),
          date: parseDate(r['delivery_date'] || r['Delivery Date'] || r['delivery date'] || r['date'] || r['Date'] || r['DATE'] || ''),
        }))
        .filter(r => r.partNo && r.qty > 0 && r.date);
      console.log('PO saved:', stockData.poConfirmed.length);

    } else if (type === 'forecast') {
      stockData.forecast = rows
        .filter(r => r && typeof r === 'object')
        .map(r => ({
          partNo: getPartNo(r),
          qty: parseQty(r['qty'] || r['Qty'] || r['QTY'] || ''),
          date: parseDate(r['date'] || r['Date'] || r['DATE'] || ''),
        }))
        .filter(r => r.partNo && r.qty > 0 && r.date);
      console.log('Forecast saved:', stockData.forecast.length);
    }

    stockData.markModified(type === 'current' ? 'currentStock' : type === 'incoming' ? 'incomingStock' : type === 'po' ? 'poConfirmed' : 'forecast');
    await stockData.save();
    res.json({ message: `${type} uploaded`, id: stockData._id });

  } catch (err) {
    console.error('Upload error:', err);
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
