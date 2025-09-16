const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user");

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// ------------------ helpers ------------------
function makeFallbackName(emailLike) {
  const raw = String(emailLike || "").trim();
  if (!raw) return "User";
  return raw.includes("@") ? raw.split("@")[0] : raw; // phone/email prefix
}

async function signTokenFull(userLike) {
  let obj = userLike?.toObject?.() ? userLike.toObject() : userLike;
  let id =
    (obj && (obj._id?.toString?.() || obj.id)) ||
    (typeof userLike === "string" ? userLike : null);

  if (!id && mongoose.isValidObjectId(userLike)) id = String(userLike);

  // Try to read from provided object
  let email = obj?.email;
  let name  = obj?.name;

  // Ensure we have from DB
  if (!email || !name) {
    const fresh = await User.findById(id).select("email name").lean();
    if (!fresh) throw new Error("User not found while signing token");
    email = email ?? fresh.email;
    name  = name  ?? fresh.name;
  }

  // Backfill if still missing
  if (!name || !String(name).trim()) {
    const computed = makeFallbackName(email);
    await User.updateOne({ _id: id }, { $set: { name: computed } }).exec();
    name = computed;
  }

  const payload = { id: String(id), email, name };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

// ------------------ controllers ------------------
exports.register = async (req, res) => {
  try {
    const {
      carrier = "",
      email = "",
      password = "",
      name = "",            // NEW: accept name from client (optional)
    } = req.body || {};

    const cleanCarrier = carrier.trim();
    const cleanEmail   = email.trim().toLowerCase();
    const cleanName    = name.trim();

    if (!cleanEmail || !password) {
      return res.status(400).json({ message: "email, password required" });
    }

    const exists = await User.findOne({ email: cleanEmail });
    if (exists) return res.status(409).json({ message: "Email already in use" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    // Use provided name or fallback from email
    const finalName = cleanName || makeFallbackName(cleanEmail);

    const user = await User.create({
      name: finalName,           // NEW
      carrier: cleanCarrier,
      email: cleanEmail,
      password: hash,
    });

    const token = await signTokenFull(user);
    const payload = { id: user._id, name: user.name, carrier: user.carrier, email: user.email };

    return res.status(201).json({
      message: "Registered",
      data: { token, user: payload },
    });
  } catch (e) {
    console.error("[register]", e);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.login = async (req, res) => {
  try {
    const { email = "", password = "" } = req.body || {};
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanEmail || !password) {
      return res.status(400).json({ message: "email and password required" });
    }

    const user = await User.findOne({ email: cleanEmail }).select("+password");
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = await signTokenFull(user);

    return res.json({
      message: "Logged in",
      data: { token, user: { id: user._id, name: user.name, email: user.email } },
    });
  } catch (e) {
    console.error("[login]", e);
    return res.status(500).json({ message: "Server error" });
  }
};


// ------------------ utility endpoints ------------------
exports.getAllUserEmails = async (req, res) => {
  try {
    const users = await User.find({}, "email");
    if (!users.length) return res.status(404).json({ success: false, message: "No users found" });
    return res.status(200).json({ success: true, data: users.map(u => u.email) });
  } catch (err) {
    console.error("Error fetching users' emails:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

exports.getAllUsernames = async (req, res) => {
  try {
    const users = await User.find({}, "name");
    if (!users.length) return res.status(404).json({ success: false, message: "No users found" });
    return res.status(200).json({ success: true, data: users.map(u => u.name) });
  } catch (err) {
    console.error("Error fetching users' names:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};
