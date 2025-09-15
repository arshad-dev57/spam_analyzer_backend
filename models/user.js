const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    carrier: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6, select: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
