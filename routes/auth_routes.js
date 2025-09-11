// routes/auth.routes.js (tum banaoge)
const router = require("express").Router();
const { register, login, getAllUserEmails, getAllUsernames,googleSignIn,googleCodeSignIn   } = require("../controllers/auth_controller");
router.post("/register", register);
router.post("/login", login);
router.get("/getalluseremails", getAllUserEmails);
router.get("/getallusernames", getAllUsernames);
router.post('/auth/google', googleSignIn);
router.post('/auth/google-code', googleCodeSignIn);
module.exports = router;
