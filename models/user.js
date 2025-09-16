const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    // NEW:
    name: { type: String, trim: true },  // make required after you backfill old users

    carrier: { type: String, required: true, trim: true },
    email:   { type: String, required: true, unique: true, lowercase: true, trim: true },

    // You currently have `select: true` which includes password by default.
    // If you want it HIDDEN by default, use select: false and keep .select("+password") in login.
    password: { type: String, required: true, minlength: 6, select: true },
  },
  { timestamps: true }
);

// Optional: ensure a fallback name before save (only if absent)
userSchema.pre("save", function(next) {
  if (!this.name || !this.name.trim()) {
    const raw = (this.email || "").trim();
    // simple fallback from email/phone
    const base = raw.includes("@") ? raw.split("@")[0] : raw;
    this.name = base || "User";
  }
  next();
});

module.exports = mongoose.model("User", userSchema);
