// routes/auth.routes.js (tum banaoge)
const router = require("express").Router();
const { register, login, getAllUserEmails, getAllUsernames } = require("../controllers/auth_controller");
router.post("/register", register);
router.post("/login", login);
router.get("/getalluseremails", getAllUserEmails);
router.get("/getallusernames", getAllUsernames);

module.exports = router;
