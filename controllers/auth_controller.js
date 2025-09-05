const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/user"); // apne model ka path use karein

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

function signToken(user) {
  // Pass only the necessary fields (`id` and `email`)
  return jwt.sign(
    { id: user._id, email: user.email, name: user.name },  // `id` and `email` are at the top level of the payload
    process.env.JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
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
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ message: "email and password required" });

    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    // Generate the token with id and email at top level
    const token = signToken(user);  
    return res.json({
      message: "Logged in",
      data: { token, user: { id: user._id, name: user.name, email: user.email } },
    });
  } catch (e) {
    console.error("[login]", e.message);
    return res.status(500).json({ message: "Server error" });
  }
};


exports.getAllUserEmails = async (req, res) => {
  try {
    // Fetch only the 'email' field from all users
    const users = await User.find({}, 'email');  // Empty {} means no filter, 'email' is the field we want

    // Check if there are users
    if (!users.length) {
      return res.status(404).json({ success: false, message: "No users found" });
    }

    // Map over the users to only return their emails
    const emails = users.map(user => user.email);

    // Return the emails in the response
    return res.status(200).json({
      success: true,
      data: emails,
    });
  } catch (err) {
    console.error("Error fetching users' emails:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

exports.getAllUsernames = async (req, res) => {
  try {
    const users = await User.find({}, 'name');  

    if (!users.length) {
      return res.status(404).json({ success: false, message: "No users found" });
    }

    // Map over the users to only return their emails
    const names = users.map(user => user.name);

    // Return the emails in the response
    return res.status(200).json({
      success: true,
      data: names,
    });
  } catch (err) {
    console.error("Error fetching users' names:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};