const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const SystemStock = require("../models/SystemStock");
const Tag = require("../models/Tag");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post("/system-stock", upload.single("file"), async (req, res) => {
  const workbook = XLSX.read(req.file.buffer);
  const sheet = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]]
  );

  await SystemStock.deleteMany({});
  await SystemStock.insertMany(
    sheet.map(r => ({
      partNo: r["Part No"],
      systemQty: r["Qty"]
    }))
  );

  res.json({ message: "System stock uploaded" });
});

router.post("/tags", upload.single("file"), async (req, res) => {
  const workbook = XLSX.read(req.file.buffer);
  const sheet = XLSX.utils.sheet_to_json(
    workbook.Sheets[workbook.SheetNames[0]]
  );

  await Tag.deleteMany({});
  await Tag.insertMany(sheet.map(r => ({ tagNo: r["Tag No"] })));

  res.json({ message: "Tag list uploaded" });
});

module.exports = router;
