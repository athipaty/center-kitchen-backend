const express = require("express");
const Tag = require("../models/Tag");
const PhysicalCount = require("../models/PhysicalCount");

const router = express.Router();

router.get('/', (req, res) => {
  res.json({message: "return from / routes"})
})

router.post("/", async (req, res) => {
  const { partNo, actualQty, location, tagNo } = req.body;

  const record = await PhysicalCount.create({
    partNo,
    actualQty,
    location,
    tagNo
  });

  res.json(record);
});

module.exports = router;
