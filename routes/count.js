const express = require("express");
const router = express.Router();

const PhysicalCount = require("../models/PhysicalCount");
const Tag = require("../models/Tag");
const SystemStock = require("../models/SystemStock");
const Location = require("../models/Location");
const ProductionPart = require("../models/ProductionPart");
const PreviousDiff = require("../models/PreviousDiff");

const multer = require("multer");
const XLSX = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

// production list...
const getProductionSet = async () => {
  try {
    const parts = await ProductionPart.distinct("partNo");
    return new Set(parts);
  } catch {
    return new Set(); // ✅ return empty set if anything fails
  }
};

router.get("/", async (req, res) => {
  try {
    const [actualResult, systemResult] = await Promise.all([
      PhysicalCount.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: "$totalQty" }
          }
        }
      ]),
      SystemStock.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: "$systemQty" }
          }
        }
      ])
    ]);
    res.json({ actual: actualResult[0]?.total || 0, system: systemResult[0]?.total || 0 });
  } catch (err) {
    console.error("COUNT TEST ERROR:", err);
    res.status(500).json({ error: "Failed to load count test" });
  }
});

router.get("/all", async (req, res) => {
  try {
    const counts = await PhysicalCount.find({}).sort({ updatedAt: -1 }).lean();
    res.json(counts);
  } catch (err) {
    console.error("ALL COUNTS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch all counts" });
  }
});

router.post("/count", async (req, res) => {
  try {
    const { tagNo, partNo, location, qtyPerBox, boxes, openBoxQty } = req.body;

    // ---------- REQUIRED ----------
    if (!tagNo || !partNo || !location) {
      return res
        .status(400)
        .json({ error: "tagNo, partNo, location are required" });
    }

    // ---------- OPEN BOX (REQUIRED) ----------
    if (openBoxQty === undefined || openBoxQty === null || openBoxQty === "") {
      return res.status(400).json({ error: "openBoxQty is required" });
    }

    const open = Number(openBoxQty);
    if (Number.isNaN(open) || open < 0) {
      return res
        .status(400)
        .json({ error: "openBoxQty must be a non-negative number" });
    }

    // ---------- OPTIONAL FIELDS ----------
    const qpb =
      qtyPerBox === undefined || qtyPerBox === "" ? 0 : Number(qtyPerBox);

    const bx = boxes === undefined || boxes === "" ? 0 : Number(boxes);

    if ([qpb, bx].some((n) => Number.isNaN(n))) {
      return res
        .status(400)
        .json({ error: "qtyPerBox and boxes must be numbers if provided" });
    }

    if (qpb < 0 || bx < 0) {
      return res
        .status(400)
        .json({ error: "qtyPerBox and boxes cannot be negative" });
    }

    if (bx > 0 && !Number.isInteger(bx)) {
      return res.status(400).json({ error: "boxes must be an integer" });
    }

    // ---------- TOTAL ----------
    const totalQty = qpb * bx + open;

    const doc = await PhysicalCount.findOneAndUpdate(
      {
        partNo: String(partNo).trim(),
        location: String(location).trim(),
      },
      {
        tagNo: String(tagNo).trim(),
        partNo: String(partNo).trim(),
        location: String(location).trim(),
        qtyPerBox: qpb,
        boxes: bx,
        openBoxQty: open,
        totalQty,
      },
      {
        upsert: true, // create if not found
        new: true, // return updated doc
        runValidators: true,
      },
    );

    res.json({ ok: true, record: doc });
  } catch (err) {
    console.error("COUNT SAVE ERROR:", err);
    if (err.code === 11000) {
      return res.status(409).json({
        error:
          "A count for this Part No + Location already exists. Use edit to update it.",
      });
    }
    res.status(500).json({ error: "Failed to save count" });
  }
});

/* =====================
   COUNT STATUS
===================== */
router.get("/status", async (req, res) => {
  try {
    const totalTags = await Tag.countDocuments();
    const countedTags = await PhysicalCount.distinct("tagNo");

    res.json({
      counted: countedTags.length,
      total: totalTags,
    });
  } catch (err) {
    console.error("COUNT STATUS ERROR:", err);
    res.status(500).json({ error: "Failed to fetch count status" });
  }
});

/* =====================
   DASHBOARD STATUS
===================== */
router.get("/dashboard-status", async (req, res) => {
  try {
    // ---------- SYSTEM ----------
    const productionSet = await getProductionSet(); // ✅
    const systemParts = (await SystemStock.distinct("partNo")).filter(
      (p) => !productionSet.has(p),
    );

    const systemTotalQtyAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: { $toDouble: "$systemQty" } },
        },
      },
    ]);
    const systemTotalQty = systemTotalQtyAgg[0]?.total || 0;

    // ---------- ACTUAL ----------
    const countedParts = (await PhysicalCount.distinct("partNo")).filter(
      (p) => !productionSet.has(p),
    );

    const countedLocations = await PhysicalCount.distinct("location");

    const actualQtyAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: null,
          total: { $sum: "$totalQty" }, // ✅ use totalQty
        },
      },
    ]);
    const actualTotalQty = actualQtyAgg[0]?.total || 0;

    // ---------- LOCATION ----------
    const totalLocations = await Location.countDocuments();

    res.json({
      qty: {
        actual: actualTotalQty,
        system: systemTotalQty,
      },
      partNo: {
        actual: countedParts.length,
        system: systemParts.length,
      },
      location: {
        actual: countedLocations.length,
        system: totalLocations,
      },
    });
  } catch (err) {
    console.error("DASHBOARD STATUS ERROR:", err.message, err.stack);
    res
      .status(500)
      .json({ error: err.message || "Failed to load dashboard status" });
  }
});

/* =====================
   VARIANCE (WITH LOCATION)
===================== */
router.get("/variance", async (req, res) => {
  try {
    const productionSet = await getProductionSet(); // ✅

    // ---------- SYSTEM ----------
    const systemAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: "$partNo",
          systemQty: {
            $sum: { $toDouble: "$systemQty" },
          },
        },
      },
    ]);

    const systemMap = new Map();
    systemAgg.forEach((s) => {
      if (!productionSet.has(s._id))
        // ✅ exclude production

        systemMap.set(s._id, s.systemQty);
    });

    // ✅ fetch previous diff data
    const prevDiffs = await PreviousDiff.find({});
    const prevDiffMap = new Map();
    prevDiffs.forEach((p) => {
      prevDiffMap.set(p.partNo, {
        price: p.price,
        diffN1: p.diffN1,
        diffN2: p.diffN2,
      });
    });

    // ---------- ACTUAL + LOCATION ----------
    const actualAgg = await PhysicalCount.aggregate([
      // group by part + location
      {
        $group: {
          _id: {
            partNo: "$partNo",
            location: "$location",
          },
          totalQty: { $sum: "$totalQty" },

          // preserve box info (assumes consistent packing per location)
          qtyPerBox: { $first: "$qtyPerBox" },
          boxes: { $sum: "$boxes" },
          openBoxQty: { $sum: "$openBoxQty" },
        },
      },

      // group by part
      {
        $group: {
          _id: "$_id.partNo",
          totalActual: { $sum: "$totalQty" },
          locations: {
            $push: {
              location: "$_id.location",
              totalQty: "$totalQty",
              qtyPerBox: "$qtyPerBox",
              boxes: "$boxes",
              openBoxQty: "$openBoxQty",
            },
          },
        },
      },
    ]);

    // ---------- COMPARE ----------
    const variances = [];

    actualAgg.forEach((a) => {
      if (productionSet.has(a._id)) return;

      const systemQty = systemMap.get(a._id);

      // ✅ these must be BEFORE the comparison check
      if (systemQty === undefined) return;
      if (Number(systemQty) === 0) return;

      if (a.totalActual !== systemQty) {
        const prev = prevDiffMap.get(a._id);
        variances.push({
          partNo: a._id,
          actual: a.totalActual,
          system: systemQty,
          locations: a.locations,
          price: prev?.price ?? null,
          diffN1: prev?.diffN1 ?? null,
          diffN2: prev?.diffN2 ?? null,
        });
      }
    });

    res.json(variances);
  } catch (err) {
    console.error("VARIANCE ERROR:", err);
    res.status(500).json({ error: "Failed to calculate variance" });
  }
});

// GET latest count record for a partNo + location
router.get("/latest", async (req, res) => {
  try {
    const { partNo, location } = req.query;

    if (!partNo || !location) {
      return res
        .status(400)
        .json({ error: "partNo and location are required" });
    }

    const doc = await PhysicalCount.findOne({
      partNo: String(partNo).trim(),
      location: String(location).trim(),
    }).sort({ createdAt: -1 });

    if (!doc) {
      return res
        .status(404)
        .json({ error: "No record found for this part/location" });
    }

    res.json(doc);
  } catch (err) {
    console.error("LATEST ERROR:", err);
    res.status(500).json({ error: "Failed to load latest record" });
  }
});

// UPDATE a specific count record
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { tagNo, partNo, location, qtyPerBox, boxes, openBoxQty } = req.body;

    // --- validate required identity fields ---
    const nextTagNo = String(tagNo ?? "").trim();
    const nextPartNo = String(partNo ?? "").trim();
    const nextLocation = String(location ?? "").trim();

    if (!nextTagNo || !nextPartNo || !nextLocation) {
      return res
        .status(400)
        .json({ error: "tagNo, partNo, location are required" });
    }

    // --- validate numbers ---
    const qpb = Number(qtyPerBox);
    const bx = Number(boxes);
    const open =
      openBoxQty === undefined || openBoxQty === "" ? 0 : Number(openBoxQty);

    if ([qpb, bx, open].some((n) => Number.isNaN(n))) {
      return res
        .status(400)
        .json({ error: "qtyPerBox, boxes, openBoxQty must be numbers" });
    }
    if (qpb < 0 || bx < 0 || open < 0) {
      return res.status(400).json({ error: "Values cannot be negative" });
    }
    if (!Number.isInteger(bx)) {
      return res.status(400).json({ error: "Boxes must be an integer" });
    }

    const totalQty = qpb * bx + open;

    // --- load current doc ---
    const current = await PhysicalCount.findById(id);
    if (!current) return res.status(404).json({ error: "Record not found" });

    // --- prevent duplicates if partNo/location changes ---
    const changingKey =
      current.partNo !== nextPartNo || current.location !== nextLocation;

    if (changingKey) {
      const exists = await PhysicalCount.findOne({
        _id: { $ne: id },
        partNo: nextPartNo,
        location: nextLocation,
      });

      if (exists) {
        return res.status(409).json({
          error:
            "Another record already exists with the same Part No + Location",
        });
      }
    }

    // --- update ---
    current.tagNo = nextTagNo;
    current.partNo = nextPartNo;
    current.location = nextLocation;
    current.qtyPerBox = qpb;
    current.boxes = bx;
    current.openBoxQty = open;
    current.totalQty = totalQty;

    await current.save();

    res.json({ ok: true, record: current });
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: "Failed to update record" });
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

router.get("/matched", async (req, res) => {
  try {
    const productionSet = await getProductionSet();

    // ✅ fetch previous diff map
    const prevDiffs = await PreviousDiff.find({});
    const prevDiffMap = new Map();
    prevDiffs.forEach((p) => {
      prevDiffMap.set(p.partNo, {
        price: p.price,
        diffN1: p.diffN1,
        diffN2: p.diffN2,
      });
    });

    const systemAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: "$partNo",
          systemQty: { $sum: { $toDouble: "$systemQty" } },
        },
      },
    ]);

    const systemMap = new Map();
    systemAgg.forEach((s) => {
      if (!productionSet.has(s._id)) systemMap.set(s._id, s.systemQty);
    });

    const actualAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: { partNo: "$partNo", location: "$location" },
          totalQty: { $sum: "$totalQty" },
          qtyPerBox: { $first: "$qtyPerBox" },
          boxes: { $sum: "$boxes" },
          openBoxQty: { $sum: "$openBoxQty" },
        },
      },
      {
        $group: {
          _id: "$_id.partNo",
          totalActual: { $sum: "$totalQty" },
          locations: {
            $push: {
              location: "$_id.location",
              totalQty: "$totalQty",
              qtyPerBox: "$qtyPerBox",
              boxes: "$boxes",
              openBoxQty: "$openBoxQty",
            },
          },
        },
      },
    ]);

    const matched = [];
    actualAgg.forEach((a) => {
      if (productionSet.has(a._id)) return;
      const systemQty = systemMap.get(a._id);
      if (systemQty !== undefined && a.totalActual === systemQty) {
        const prev = prevDiffMap.get(a._id);
        matched.push({
          partNo: a._id,
          actual: a.totalActual,
          system: systemQty,
          locations: a.locations,
          price: prev?.price ?? null, // ✅
          diffN1: prev?.diffN1 ?? null, // ✅
          diffN2: prev?.diffN2 ?? null, // ✅
        });
      }
    });

    res.json(matched);
  } catch (err) {
    console.error("MATCHED ERROR:", err);
    res.status(500).json({ error: "Failed to fetch matched parts" });
  }
});

router.get("/uncounted", async (req, res) => {
  try {
    const productionSet = await getProductionSet();

    const prevDiffs = await PreviousDiff.find({});
    const prevDiffMap = new Map();
    prevDiffs.forEach((p) => {
      prevDiffMap.set(p.partNo, {
        price: p.price,
        diffN1: p.diffN1,
        diffN2: p.diffN2,
      });
    });

    const systemAgg = await SystemStock.aggregate([
      {
        $group: {
          _id: "$partNo",
          systemQty: { $sum: { $toDouble: "$systemQty" } },
        },
      },
    ]);

    const countedPartNos = await PhysicalCount.distinct("partNo");
    const countedSet = new Set(countedPartNos);

    const uncounted = [];
    systemAgg.forEach((s) => {
      if (productionSet.has(s._id)) return;
      if (countedSet.has(s._id)) return;
      const prev = prevDiffMap.get(s._id);
      uncounted.push({
        partNo: s._id,
        system: s.systemQty,
        price: prev?.price ?? null,
        diffN1: prev?.diffN1 ?? null,
        diffN2: prev?.diffN2 ?? null,
      });
    });

    res.json(uncounted);
  } catch (err) {
    console.error("UNCOUNTED ERROR:", err);
    res.status(500).json({ error: "Failed to fetch uncounted parts" });
  }
});

router.get("/unrecognized", async (req, res) => {
  try {
    const productionSet = await getProductionSet(); // ✅

    // all system part nos
    const systemPartNos = await SystemStock.distinct("partNo");
    const systemSet = new Set(systemPartNos);

    // all counted part nos
    const countedAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: "$partNo",
          totalActual: { $sum: "$totalQty" },
          locations: {
            $push: {
              location: "$location",
              totalQty: "$totalQty",
              qtyPerBox: "$qtyPerBox",
              boxes: "$boxes",
              openBoxQty: "$openBoxQty",
            },
          },
        },
      },
    ]);

    // return counted parts that don't exist in system
    const unrecognized = countedAgg
      .filter((c) => !systemSet.has(c._id))
      .filter((c) => !productionSet.has(c._id)) // ✅ exclude production

      .map((c) => ({
        partNo: c._id,
        actual: c.totalActual,
        system: 0,
        locations: c.locations,
      }));

    res.json(unrecognized);
  } catch (err) {
    console.error("UNRECOGNIZED ERROR:", err);
    res.status(500).json({ error: "Failed to fetch unrecognized parts" });
  }
});

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

router.get("/production-counted", async (req, res) => {
  try {
    const productionSet = await getProductionSet();

    // get all counted parts that ARE in production list
    const countedAgg = await PhysicalCount.aggregate([
      {
        $group: {
          _id: "$partNo",
          totalActual: { $sum: "$totalQty" },
          locations: {
            $push: {
              location: "$location",
              totalQty: "$totalQty",
              qtyPerBox: "$qtyPerBox",
              boxes: "$boxes",
              openBoxQty: "$openBoxQty",
            },
          },
        },
      },
    ]);

    // ✅ only keep parts that ARE in production list
    const productionCounted = countedAgg
      .filter((c) => productionSet.has(c._id))
      .map((c) => ({
        partNo: c._id,
        actual: c.totalActual,
        locations: c.locations,
      }));

    res.json(productionCounted);
  } catch (err) {
    console.error("PRODUCTION COUNTED ERROR:", err);
    res.status(500).json({ error: "Failed to fetch production counted parts" });
  }
});



router.delete("/:id", async (req, res) => {
  try {
    const doc = await PhysicalCount.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: "Record not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

module.exports = router;
