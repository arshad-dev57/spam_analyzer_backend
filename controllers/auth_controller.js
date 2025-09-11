// controllers/auth.controller.js
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const axios = require("axios");
const { OAuth2Client } = require("google-auth-library");

const User = require("../models/user");

const SALT_ROUNDS = Number(process.env.SALT_ROUNDS || 10);
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "7d";

// ----- Google OAuth env (set in .env) -----
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";         // Web OAuth client ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ""; // keep on server
const GOOGLE_REDIRECT_URI = "postmessage"; // for installed apps / Flutter mobile
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ------------------ helpers ------------------
async function signTokenFull(userLike) {
  let obj = userLike?.toObject?.() ? userLike.toObject() : userLike;
  let id =
    (obj && (obj._id?.toString?.() || obj.id)) ||
    (typeof userLike === "string" ? userLike : null);

  if (!id && mongoose.isValidObjectId(userLike)) id = String(userLike);

  let email = obj?.email;
  let name  = obj?.name;

  if (!email || !name) {
    const fresh = await User.findById(id).select("email name").lean();
    if (!fresh) throw new Error("User not found while signing token");
    email = email ?? fresh.email;
    name  = name  ?? fresh.name;
  }
  const payload = { id: String(id), email, name };
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** find or create user from Google profile */
async function findOrCreateGoogleUser({ email, name }) {
  const cleanEmail = (email || "").trim().toLowerCase();
  const cleanName  = (name || email?.split("@")[0] || "User").trim();

  let user = await User.findOne({ email: cleanEmail }).lean();
  if (user) {
    // optional: keep name in sync if empty
    if (!user.name && cleanName) {
      await User.updateOne({ _id: user._id }, { $set: { name: cleanName } });
      user = await User.findById(user._id).lean();
    }
    return user;
  }

  // if your schema requires password, set a random one
  const random = crypto.randomBytes(32).toString("hex");
  const hash = await bcrypt.hash(random, SALT_ROUNDS);

  user = await User.create({
    name: cleanName,
    email: cleanEmail,
    password: hash, // safe default if required
  });
  return user.toObject ? user.toObject() : user;
}

// ------------------ email/password flows ------------------
exports.register = async (req, res) => {
  try {
    const { name = "", email = "", password = "" } = req.body || {};
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanEmail || !password) {
      return res.status(400).json({ message: "email, password required" });
    }

    const exists = await User.findOne({ email: cleanEmail });
    if (exists) return res.status(409).json({ message: "Email already in use" });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await User.create({ name: cleanName, email: cleanEmail, password: hash });

    const token = await signTokenFull(user);

    return res.status(201).json({
      message: "Registered",
      data: { token, user: { id: user._id, name: user.name, email: user.email } },
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
    console.log("User logged in :", token);

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

// ------------------ Google Sign-In (ID Token path) ------------------
/**
 * POST /auth/google
 * body: { idToken: string }
 */
exports.googleSignIn = async (req, res) => {
  try {
    const { idToken } = req.body || {};
    if (!idToken) return res.status(400).json({ message: "idToken required" });

    // verify with Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload(); // {sub, email, email_verified, name, picture, ...}

    if (!payload?.email || payload.email_verified === false) {
      return res.status(401).json({ message: "Google email not verified" });
    }

    const user = await findOrCreateGoogleUser({
      email: payload.email,
      name: payload.name,
    });

    const token = await signTokenFull(user);

    return res.json({
      message: "Google login successful",
      data: {
        token,
        user: { id: user._id || user.id, name: user.name, email: user.email },
      },
    });
  } catch (e) {
    console.error("[googleSignIn]", e?.response?.data || e.message);
    return res.status(401).json({ message: "Invalid Google token" });
  }
};

// ------------------ Google Sign-In (Auth Code path) ------------------
/**
 * POST /auth/google-code
 * body: { code: string }
 * Stronger flow; can return refresh_token on first consent.
 */
exports.googleCodeSignIn = async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ message: "code required" });

    // exchange code for tokens
    const tokenRes = await axios.post("https://oauth2.googleapis.com/token", {
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: GOOGLE_REDIRECT_URI,
      grant_type: "authorization_code",
    });

    const { id_token /* access_token, refresh_token */ } = tokenRes.data || {};
    if (!id_token) return res.status(401).json({ message: "Google exchange failed" });

    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email || payload.email_verified === false) {
      return res.status(401).json({ message: "Google email not verified" });
    }

    const user = await findOrCreateGoogleUser({
      email: payload.email,
      name: payload.name,
    });

    // TODO: if you want to store refresh_token for Google APIs, add fields in schema and save here.

    const token = await signTokenFull(user);

    return res.json({
      message: "Google login successful",
      data: {
        token,
        user: { id: user._id || user.id, name: user.name, email: user.email },
      },
    });
  } catch (e) {
    console.error("[googleCodeSignIn]", e?.response?.data || e.message);
    return res.status(401).json({ message: "Google exchange failed" });
  }
};
