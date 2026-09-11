const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const MarketListing = require("../../models/market/MarketListing");
const { requireMarketAuth } = require("../../utils/marketAuth");

function toClient(listing) {
  const obj = listing.toObject ? listing.toObject() : listing;
  const [lng, lat] = obj.location?.coordinates ?? [null, null];
  return {
    id: obj._id,
    title: obj.title,
    description: obj.description,
    price: obj.price,
    category: obj.category,
    images: obj.images,
    lat,
    lng,
    locationName: obj.locationName,
    status: obj.status,
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    sellerId: obj.seller?._id ?? obj.seller,
    seller: obj.seller?.name ? { id: obj.seller._id, name: obj.seller.name } : undefined,
    distanceKm: typeof obj.distanceKm === "number" ? obj.distanceKm : undefined,
  };
}

router.post("/", requireMarketAuth, async (req, res) => {
  try {
    const { title, description, price, category, images, lat, lng, locationName } = req.body;
    if (!title || !description || typeof price !== "number" || !category) {
      return res.status(400).json({ error: "title, description, price, and category are required" });
    }
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng are required" });
    }

    const listing = await MarketListing.create({
      title,
      description,
      price,
      category,
      images: images ?? [],
      location: { type: "Point", coordinates: [lng, lat] },
      locationName,
      seller: req.marketAuth.userId,
    });
    res.status(201).json({ listing: toClient(listing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Search active listings near a point, ordered by distance.
router.get("/", async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radiusKm = Math.min(Number(req.query.radiusKm) || 25, 500);
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      return res.status(400).json({ error: "lat and lng query params are required" });
    }

    const match = { status: "ACTIVE" };
    if (req.query.category) match.category = req.query.category;
    if (req.query.q) {
      const re = new RegExp(req.query.q, "i");
      match.$or = [{ title: re }, { description: re }];
    }

    const results = await MarketListing.aggregate([
      {
        $geoNear: {
          near: { type: "Point", coordinates: [lng, lat] },
          distanceField: "distanceMeters",
          maxDistance: radiusKm * 1000,
          spherical: true,
          query: match,
        },
      },
      { $sort: { distanceMeters: 1 } },
      { $limit: limit },
      {
        $lookup: {
          from: "marketusers",
          localField: "seller",
          foreignField: "_id",
          as: "seller",
        },
      },
      { $unwind: "$seller" },
      { $addFields: { distanceKm: { $divide: ["$distanceMeters", 1000] } } },
    ]);

    res.json({ listings: results.map(toClient) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/mine", requireMarketAuth, async (req, res) => {
  try {
    const listings = await MarketListing.find({ seller: req.marketAuth.userId }).sort({ createdAt: -1 });
    res.json({ listings: listings.map(toClient) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Listing not found" });
    const listing = await MarketListing.findById(req.params.id).populate("seller", "name");
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    res.json({ listing: toClient(listing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/:id", requireMarketAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Listing not found" });
    const listing = await MarketListing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    if (String(listing.seller) !== req.marketAuth.userId) {
      return res.status(403).json({ error: "You do not own this listing" });
    }

    const { title, description, price, category, images, status } = req.body;
    if (title !== undefined) listing.title = title;
    if (description !== undefined) listing.description = description;
    if (price !== undefined) listing.price = price;
    if (category !== undefined) listing.category = category;
    if (images !== undefined) listing.images = images;
    if (status !== undefined) listing.status = status;
    await listing.save();

    res.json({ listing: toClient(listing) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/:id", requireMarketAuth, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Listing not found" });
    const listing = await MarketListing.findById(req.params.id);
    if (!listing) return res.status(404).json({ error: "Listing not found" });
    if (String(listing.seller) !== req.marketAuth.userId) {
      return res.status(403).json({ error: "You do not own this listing" });
    }
    await listing.deleteOne();
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
