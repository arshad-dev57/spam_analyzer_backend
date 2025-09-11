const Keyword = require('../models/keyword_model');

exports.addKeyword = async (req, res, next) => {
  try {
    const { word } = req.body;
    if (!word || !word.trim()) {
      return res.status(400).json({ message: 'word is required' });
    }

    const doc = new Keyword({
      word,
      createdBy: req.user?.id || undefined, 
    });

    await doc.save();
    return res.status(201).json({ message: 'created', data: doc });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ message: 'keyword already exists' });
    }
    next(err);
  }
};

exports.listKeywords = async (req, res, next) => {
  try {
    const page  = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 200);
    const skip  = (page - 1) * limit;

    const q = (req.query.q || '').trim().toLowerCase();
    const filter = q ? { norm: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {};

    const [items, total] = await Promise.all([
      Keyword.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Keyword.countDocuments(filter),
    ]);

    res.json({
      page,
      limit,
      total,
      items,
    });
  } catch (err) {
    next(err);
  }
};

exports.deleteKeyword = async (req, res, next) => {
  try {
    const out = await Keyword.findByIdAndDelete(req.params.id);
    if (!out) return res.status(404).json({ message: 'not found' });
    res.json({ message: 'deleted' });
  } catch (err) {
    next(err);
  }
};

exports.bulkAdd = async (req, res, next) => {
  try {
    let words = Array.isArray(req.body.words) ? req.body.words : [];
    words = words.map(w => (w || '').toString().trim()).filter(Boolean);

    if (!words.length) return res.status(400).json({ message: 'words[] required' });

    const docs = words.map(w => ({
      word: w,
      norm: w.toLowerCase(),
      createdBy: req.user?.id || undefined,
    }));

    const result = await Keyword.insertMany(docs, { ordered: false });
    res.status(201).json({ message: 'bulk created', inserted: result.length });
  } catch (err) {
    // swallow duplicate errors in bulk inserts and count what got in
    if (err?.name === 'BulkWriteError' || err?.writeErrors) {
      const inserted = err.result?.nInserted ?? 0;
      return res.status(207).json({
        message: 'bulk partially inserted',
        inserted,
        errors: (err.writeErrors || []).map(e => e.errmsg),
      });
    }
    next(err);
  }
};
