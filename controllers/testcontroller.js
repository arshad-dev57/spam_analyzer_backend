const Test = require('../models/testmodel');

const insertTest = async (req, res) => {
  try {
    const newTest = new Test({ name: req.body.name });
    const saved = await newTest.save();
    res.status(201).json({ success: true, data: saved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = { insertTest };
