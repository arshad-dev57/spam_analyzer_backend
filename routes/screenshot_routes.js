const express = require('express');
const upload = require('../middleware/multer');
const { uploadScreenshot, getAllAnalyzedScreenshots, softDeleteScreenshot, getDeletedScreenshots, restoreScreenshot, permanentDeleteScreenshot,getlogginscreenshot,getallfilteredscreenshots,getallnamedfilterscreenshots } = require('../controllers/screenshot_controller');
const middleware = require('../middleware/auth_middleware');
const router = express.Router();

router.post('/postscreenshot', upload.single('image'), middleware, uploadScreenshot);
router.get('/getlogginscreenshot',middleware, getlogginscreenshot);
router.get('/getallfilteredscreenshots', getallfilteredscreenshots);
router.get('/getanalyzed', getAllAnalyzedScreenshots);
router.delete('/delete/:id', softDeleteScreenshot); // soft delete
router.get('/recently-deleted', getDeletedScreenshots); // recently deleted list
router.post('/restore/:id', restoreScreenshot); // restore
router.delete('/permanent/:id', permanentDeleteScreenshot); // permanent delete
router.get('/getallnamedfilterscreenshots', getallnamedfilterscreenshots);
module.exports = router;
