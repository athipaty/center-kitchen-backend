const mongoose = require("mongoose");

const SupplierSchema = new mongoose.Schema(
    {
        name: {type: String, required: true},
        contact: {type: String},
        phone: {type: String},
    },
    { timsstamps: true},
)

module.exports = mongoose.model("Supplier", SupplierSchema);
