const express = require('express');
const upload = require('../middleware/multer');
const { uploadScreenshot, getAllAnalyzedScreenshots } = require('../controllers/screenshot_controller');

const router = express.Router();

router.post('/postscreenshot', upload.single('imageUrl'), uploadScreenshot);
router.get('/getanalyzed', getAllAnalyzedScreenshots);

module.exports = router;
