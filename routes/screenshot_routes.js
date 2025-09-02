const express = require('express');
const upload = require('../middleware/multer');
const { uploadScreenshot, getAllAnalyzedScreenshots, softDeleteScreenshot, getDeletedScreenshots, restoreScreenshot, permanentDeleteScreenshot } = require('../controllers/screenshot_controller');

const router = express.Router();

router.post('/postscreenshot', upload.single('image'), uploadScreenshot);
router.get('/getanalyzed', getAllAnalyzedScreenshots);
router.delete('/delete/:id', softDeleteScreenshot); // soft delete
router.get('/recently-deleted', getDeletedScreenshots); // recently deleted list
router.post('/restore/:id', restoreScreenshot); // restore
router.delete('/permanent/:id', permanentDeleteScreenshot); // permanent delete
module.exports = router;
