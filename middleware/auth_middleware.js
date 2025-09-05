const jwt = require("jsonwebtoken");

module.exports = function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.split(" ")[1] : null;
    if (!token) return res.status(401).json({ message: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach both id and email to req.user (both at top level)
    req.user = { id: decoded.id, email: decoded.email, name: decoded.name };  // `email` and `id` are directly available

    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
};
