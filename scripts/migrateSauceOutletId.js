require("dotenv").config(); 
const mongoose = require("mongoose");
const Outlet = require("../models/Outlet");
const Sauce = require("../models/Sauce");

async function migrate() {
  await mongoose.connect(process.env.MONGO_URI);

  const outlets = await Outlet.find();

  for (const outlet of outlets) {
    const result = await Sauce.updateMany(
      { outletName: outlet.name },
      { $set: { outletId: outlet._id } }
    );

    console.log(
      `Updated ${result.modifiedCount} sauces for ${outlet.name}`
    );
  }

  console.log("Migration complete");
  process.exit();
}

migrate();
