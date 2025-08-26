// controllers/analyzedScreenshot.controller.js

const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');

// ==== CONFIG ====
const OCR_TIMEOUT_MS = 30_000; // bumped for reliability
const TESS_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

// ==== Cloudinary stream upload ====
function streamUpload(buffer, folder) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ==== Image compression for faster upload ====
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
    m: /[\u043C]/g, // м
    s: /[\u0455]/g, // ѕ
    n: /[\u043D]/g, // н
    b: /[\u0432]/g, // в (loose)
    h: /[\u04BB]/g, // һ
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

// ==== Robust spam detection ====
function hasSpam(rawText) {
  if (!rawText) return false;

  // quick hits
  if (/\bspam\b/i.test(rawText)) return true;
  if (/\bs\s*p\s*a\s*m\b/i.test(rawText)) return true;

  // OCR confusions across whitespace/newlines
  if (/\b[s\$5]\s*[pP]\s*[a@]\s*[mMnRN]\b/.test(rawText)) return true;

  // normalized check (handles confusables & symbols)
  const norm = normalizeForOCR(rawText);
  if (norm.includes('spam')) return true;

  // optional synonyms that might indicate spam content
  const alt = ['scam', 'junk', 'fraud'];
  if (new RegExp(`\\b(${alt.join('|')})\\b`, 'i').test(rawText)) return true;
  if (new RegExp(`(${alt.join('|')})`).test(norm)) return true;

  return false;
}

// ==== OCR runner with fallback PSMs ====
async function runOCR(buf, psm = 6) {
  const ocrInput = await sharp(buf).grayscale().normalize().toBuffer();
  const ocrRes = await withTimeout(
    tesseract.recognize(ocrInput, 'eng', {
      langPath: TESS_LANG_PATH,
      tessedit_pageseg_mode: String(psm), // tesseract.js respects this key
      preserve_interword_spaces: '1',
    }),
    OCR_TIMEOUT_MS
  );
  return (ocrRes.data.text || '').trim();
}

// ==== CONTROLLERS ====

// POST /api/screenshot[?debug=1]
const uploadScreenshot = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const folderName = `screenshots/${new Date().toISOString().split('T')[0]}`;

    // 1) Upload compressed (network-friendly)
    const compressedBuffer = await compressImageBuffer(req.file.buffer);
    const uploadResult = await streamUpload(compressedBuffer, folderName);

    // 2) OCR (original → compressed → alternate PSMs)
    let text = '';
    try {
      text = await runOCR(req.file.buffer, 6); // PSM 6 works well for blocks
      if (!text) text = await runOCR(compressedBuffer, 6);
      if (!text) text = await runOCR(req.file.buffer, 7); // single line
      if (!text) text = await runOCR(req.file.buffer, 3); // auto
    } catch (e) {
      console.warn('OCR issue:', e.message);
    }

    const containsSpam = hasSpam(text);

    // phone number extraction
    const matches = text.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0]?.replace(/\s+/g, ' ').trim() || 'Not Found';

    // store
    const doc = await AnalyzedScreenshot.create({
      imageUrl: uploadResult.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || 'Unknown',
      carrier: req.body.carrier || 'Unknown',
      isSpam: containsSpam,
    });

    // response
    const payload = {
      success: true,
      data: {
        screenshotUrl: uploadResult.secure_url,
        extractedNumber: extracted,
        id: doc._id,
        time: doc.time,
        toNumber: doc.toNumber,
        carrier: doc.carrier,
        isSpam: doc.isSpam,
      },
    };

    // quick debug switch
    if (req.query.debug === '1') {
      payload.data.rawOCR = text;
      payload.data.normalized = normalizeForOCR(text);
    }

    return res.status(201).json(payload);
  } catch (err) {
    console.error('❌ Upload error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};


const getAllAnalyzedScreenshots = async (req, res) => {
  try {
    const all = await AnalyzedScreenshot.find().sort({ time: -1 });
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
      })),
    });
  } catch (err) {
    console.error('❌ Fetch error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
};

module.exports = { uploadScreenshot, getAllAnalyzedScreenshots };
