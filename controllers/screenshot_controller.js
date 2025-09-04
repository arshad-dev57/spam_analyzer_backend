// controllers/analyzedScreenshot.controller.js

const path = require('path');
const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');

const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
const OCR_TIMEOUT_MS = isProd ? 45_000 : 30_000;

const TESS_LANG_PATH = path.join(process.cwd(), 'public', 'tessdata');
function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

async function compressImageBuffer(inputBuffer) {
  const targetSize = 100 * 1024; // ~100KB
  let quality = 80,
    width = 1000,
    best = inputBuffer;

  while (width >= 200) {
    for (let q = quality; q >= 30; q -= 10) {
      const out = await sharp(inputBuffer)
        .resize({ width, withoutEnlargement: true })
        .jpeg({ quality: q, progressive: true, chromaSubsampling: '4:4:4' })
        .toBuffer();
      if (out.byteLength <= targetSize) return out;
      best = out;
    }
    width -= 100;
  }
  return best;
}

// ==== Promise timeout helper ====
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR_TIMEOUT')), ms)),
  ]);
}

// ==== Confusable → Latin mapping (Cyrillic/Greek lookalikes) ====
function mapConfusablesToLatin(s) {
  const map = {
    a: /[\u0430\u03B1]/g, // Cyrillic а, Greek α
    e: /[\u0435\u03B5]/g, // е, ε
    i: /[\u0456\u03B9]/g, // і, ι
    o: /[\u043E\u03BF]/g, // о, ο
    p: /[\u0440\u03C1]/g, // р, ρ
    c: /[\u0441\u03C3\u03F2]/g, // с, σ, ϲ
    y: /[\u0443\u03C5]/g, // у, υ
    x: /[\u0445\u03C7]/g, // х, χ
    m: /[\u043C]/g,       // м
    s: /[\u0455]/g,       // ѕ
    n: /[\u043D]/g,       // н
    b: /[\u0432]/g,       // в
    h: /[\u04BB]/g,       // һ
  };
  let out = s;
  for (const [lat, rx] of Object.entries(map)) out = out.replace(rx, lat);
  return out;
}

// ==== Normalization for OCR noise & lookalikes ====
function normalizeForOCR(s) {
  return mapConfusablesToLatin(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '') // strip accents
      .replace(/rn/g, 'm') // rn -> m
      .replace(/\$/g, 's') // $ -> s
      .replace(/5/g, 's') // 5 -> s
      .replace(/@/g, 'a') // @ -> a
      .replace(/0/g, 'o') // 0 -> o
      .replace(/[|!]/g, 'l') // |/! -> l
  ).replace(/[\W_]+/g, ''); // drop non-letters/digits
}

function hasSpam(rawText) {
  if (!rawText) return false;

  if (/\bspam\b/i.test(rawText)) return true;
  if (/\bs\s*p\s*a\s*m\b/i.test(rawText)) return true;
  if (/\b[s\$5]\s*[pP]\s*[a@]\s*[mMnRN]\b/.test(rawText)) return true;

  const norm = normalizeForOCR(rawText);
  if (norm.includes('spam')) return true;

  const alt = ['scam', 'junk', 'fraud'];
  if (new RegExp(`\\b(${alt.join('|')})\\b`, 'i').test(rawText)) return true;
  if (new RegExp(`(${alt.join('|')})`).test(norm)) return true;

  return false;
}

// ==== OCR runner with fallback PSMs ====
async function runOCR(buf, psm = 6) {
  const ocrInput = await sharp(buf).grayscale().normalize().toBuffer();
  const t0 = Date.now();
  const ocrRes = await withTimeout(
    tesseract.recognize(ocrInput, 'eng', {
      langPath: TESS_LANG_PATH,              // local bundled data
      tessedit_pageseg_mode: String(psm),    // 6=Block, 7=Single line, 3=Auto
      preserve_interword_spaces: '1',
    }),
    OCR_TIMEOUT_MS
  );
  const text = (ocrRes.data.text || '').trim();
  console.log(`[OCR] PSM=${psm} len=${text.length} took=${Date.now()-t0}ms`);
  return text;
}



const uploadScreenshot = async (req, res) => {
  try {
    // ensure auth applied
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Auth required" });
    }
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const today = new Date().toISOString().split("T")[0];
    const folderName = `screenshots/${req.user.id}/${today}`; // << user-specific folder

    // 1) Upload compressed
    const compressedBuffer = await compressImageBuffer(req.file.buffer);
    const uploadResult = await streamUpload(compressedBuffer, folderName);

    // 2) OCR attempts
    let text = "";
    let ocrErrors = [];
    try {
      text = await runOCR(req.file.buffer, 6);
      if (!text) text = await runOCR(compressedBuffer, 6);
      if (!text) text = await runOCR(req.file.buffer, 7);
      if (!text) text = await runOCR(req.file.buffer, 3);
    } catch (e) {
      console.warn("OCR issue:", e.message);
      ocrErrors.push(e.message);
    }

    const containsSpam = hasSpam(text);

    // phone extraction
    const matches = text?.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0]?.replace(/\s+/g, " ").trim() || "Not Found";

    // 3) SAVE with user
    const doc = await AnalyzedScreenshot.create({
      user: req.user.id,      
      email: req.user.email,                  // << per-user ownership
      imageUrl: uploadResult.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || "Unknown",
      carrier: req.body.carrier || "Unknown",
      isSpam: containsSpam,
    });

    const payload = {
      success: true,
      data: {
        id: doc._id,
        screenshotUrl: uploadResult.secure_url,
        extractedNumber: extracted,
        time: doc.time,
        toNumber: doc.toNumber,
        carrier: doc.carrier,
        isSpam: doc.isSpam,
      },
    };

    if (req.query.debug === "1") {
      payload.data.rawOCR = text;
      payload.data.normalized = normalizeForOCR(text);
      payload.data.env = { isProd, langPath: TESS_LANG_PATH, timeoutMs: OCR_TIMEOUT_MS };
      if (ocrErrors.length) payload.data.ocrErrors = ocrErrors;
    }

    return res.status(201).json(payload);
  } catch (err) {
    console.error("❌ Upload error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


const getAllAnalyzedScreenshots = async (req, res) => {
  try {
    const all = await AnalyzedScreenshot
      .find({ isDeleted: { $ne: true } })   // <-- only not-deleted
      .sort({ time: -1 });

    res.status(200).json({
      success: true,
      count: all.length,
      data: all.map(item => ({
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        id: item._id,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,        // (optional) expose for safety
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};
const getallfilteredscreenshots = async (req, res) => {
  try {
    const userEmail = req.query.email || req.user.email; 

    if (!userEmail) {
      return res.status(400).json({ success: false, error: 'Email is required' });
    }

    const all = await AnalyzedScreenshot
      .find({
        email: userEmail,  
        isDeleted: { $ne: true }  
      })
      .sort({ time: -1 });

    res.status(200).json({
      success: true,
      count: all.length,
      data: all.map(item => ({
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        id: item._id,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,  // (optional) expose for safety
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};


const getlogginscreenshot = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Auth required" });
    }

    // optional: pagination (defaults)
    const page  = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.max(parseInt(req.query.limit || "20", 10), 1);
    const skip  = (page - 1) * limit;

    const filter = { user: req.user.id, isDeleted: { $ne: true } };

    const [items, total] = await Promise.all([
      AnalyzedScreenshot.find(filter)
        .sort({ time: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      AnalyzedScreenshot.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      page,
      limit,
      total,
      data: items.map((item) => ({
        id: item._id,
        screenshotUrl: item.imageUrl,
        extractedNumber: item.extractedNumber,
        time: item.time,
        toNumber: item.toNumber,
        carrier: item.carrier,
        isSpam: item.isSpam,
        isDeleted: !!item.isDeleted,
      })),
    });
  } catch (err) {
    console.error("❌ Fetch error:", err);
    return res.status(500).json({ success: false, error: "Server error" });
  }
};

const softDeleteScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await AnalyzedScreenshot.findByIdAndUpdate(
      id,
      { isDeleted: true, deletedAt: new Date() },
      { new: true }
    );
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Screenshot not found' });
    }
    res.status(200).json({ success: true, message: 'Moved to Recently Deleted', data: updated });
  } catch (err) {
    console.error('❌ Soft delete error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};


const getDeletedScreenshots = async (req, res) => {
  try {
    const deleted = await AnalyzedScreenshot.find({ isDeleted: true }).sort({ deletedAt: -1 });
    res.status(200).json({ success: true, count: deleted.length, data: deleted });
  } catch (err) {
    console.error('❌ Fetch deleted error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// RESTORE
const restoreScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const updated = await AnalyzedScreenshot.findByIdAndUpdate(
      id,
      { isDeleted: false, deletedAt: null },
      { new: true }
    );
    if (!updated) return res.status(404).json({ success: false, error: 'Screenshot not found' });
    res.status(200).json({ success: true, message: 'Screenshot restored', data: updated });
  } catch (err) {
    console.error('❌ Restore error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

// PERMANENT DELETE
const permanentDeleteScreenshot = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await AnalyzedScreenshot.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Screenshot not found' });
    res.status(200).json({ success: true, message: 'Screenshot permanently deleted' });
  } catch (err) {
    console.error('❌ Permanent delete error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = { uploadScreenshot, getAllAnalyzedScreenshots, softDeleteScreenshot, getDeletedScreenshots, restoreScreenshot, permanentDeleteScreenshot,getlogginscreenshot,getallfilteredscreenshots };
