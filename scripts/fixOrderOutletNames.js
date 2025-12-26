const mongoose = require("mongoose");
const Order = require("../models/Order");
const Outlet = require("../models/Outlet");

// ⚠️ IMPORTANT: ensure your DB URI is loaded
require("dotenv").config();

async function run() {
  try {
    console.log("🔌 Connecting to database...");
    await mongoose.connect(process.env.MONGO_URI);

    const outlets = await Outlet.find();
    const outletMap = {};
    outlets.forEach((o) => {
      outletMap[o._id.toString()] = o.name;
    });

    const orders = await Order.find({
      $or: [{ outletName: "" }, { outletName: { $exists: false } }],
    });

    console.log(`🧾 Found ${orders.length} orders to fix`);

    for (const order of orders) {
      order.outletName =
        outletMap[order.outletId?.toString()] || "Unknown Outlet";
      await order.save();
    }

    console.log("✅ Orders updated successfully");
    process.exit(0);
  } catch (err) {
    console.error("❌ Script failed:", err);
    process.exit(1);
  }
}

run();
