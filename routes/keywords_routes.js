const router = require('express').Router();
const ctrl = require('../controllers/keyword_controller');
// const auth = require('../middleware/auth'); // if you want to protect routes

// router.use(auth); // optional

router.post('/addkeyword', ctrl.addKeyword);
router.get('/getkeywords', ctrl.listKeywords);
router.delete('/:id', ctrl.deleteKeyword);
router.post('/bulk', ctrl.bulkAdd);

module.exports = router;
