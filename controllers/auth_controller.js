const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/user"); // apne model ka path use karein

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * body: { name, email, password }
 */
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password)
      return res.status(400).json({ message: "name, email, password required" });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ message: "Email already in use" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({ name, email, password: hash });

    const token = signToken(user._id);
    return res.status(201).json({
      message: "Registered",
      data: { token, user: { id: user._id, name: user.name, email: user.email } },
    });
  } catch (e) {
    console.error("[register]", e.message);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * body: { email, password }
 */
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: "email and password required" });

    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = signToken(user._id);
    return res.json({
      message: "Logged in",
      data: { token, user: { id: user._id, name: user.name, email: user.email } },
    });
  } catch (e) {
    console.error("[login]", e.message);
    return res.status(500).json({ message: "Server error" });
  }
};
