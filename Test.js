const mongoose = require("mongoose");
const Product = require("./models/Product"); // adjust path

const MONGO_URI = "mongodb+srv://athipaty_ck:athipaty_ck@cluster0.wf1ttt9.mongodb.net/?appName=Cluster0";

async function run() {
  await mongoose.connect(MONGO_URI);

  const result = await Product.updateMany(
    { unit: { $exists: false } },
    { $set: { unit: "" } }
  );

  console.log("Updated:", result.modifiedCount);
  await mongoose.disconnect();
}

run();
