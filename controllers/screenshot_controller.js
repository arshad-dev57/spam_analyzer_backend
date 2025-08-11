const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');
// --- keep imports same ---

const OCR_TIMEOUT_MS = 20_000;
const TESS_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

// helpers
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
  const targetSize = 100 * 1024;
  let quality = 80, width = 1000, best = inputBuffer;

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

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR_TIMEOUT')), ms)),
  ]);
}

// --- NEW: robust spam detection ---
function normalizeForOCR(s) {
  return s
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // remove diacritics
    .replace(/rn/g, 'm')   // rn -> m
    .replace(/\$/g, 's')   // $ -> s
    .replace(/5/g, 's')    // 5 -> s
    .replace(/@/g, 'a')    // @ -> a
    .replace(/0/g, 'o')    // 0 -> o
    .replace(/[|!]/g, 'l') // |/! -> l
    .replace(/[\W_]+/g, ''); // drop non-letters/digits
}

function hasSpam(rawText) {
  // 1) exact word
  if (/\bspam\b/i.test(rawText)) return true;
  // 2) letters with arbitrary whitespace/newlines between
  if (/\bs\s*p\s*a\s*m\b/i.test(rawText)) return true;
  // 3) common OCR confusions (5/$ for s, @ for a, rn for m)
  if (/\b[s\$5]\s*[pP]\s*[a@]\s*[mMnRN]\b/.test(rawText)) return true;
  // 4) normalized pass (removes spaces & lookalikes)
  if (normalizeForOCR(rawText).includes('spam')) return true;

  return false;
}

// ---- controller ----
const uploadScreenshot = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const folderName = `screenshots/${new Date().toISOString().split('T')[0]}`;

    // 1) Upload ke liye compress (network fast)
    const compressedBuffer = await compressImageBuffer(req.file.buffer);
    const result = await streamUpload(compressedBuffer, folderName);

    // 2) OCR **original** buffer par (zyada accurate)
    let text = '';
    try {
      // light preproc: grayscale + normalize (optional but helps)
      const ocrInput = await sharp(req.file.buffer).grayscale().normalize().toBuffer();

      const ocrRes = await withTimeout(
        tesseract.recognize(ocrInput, 'eng', {
          langPath: TESS_LANG_PATH,
          tessedit_pageseg_mode: '11',        // SPARSE_TEXT
          preserve_interword_spaces: '1',
        }),
        OCR_TIMEOUT_MS
      );
      text = ocrRes.data.text || '';
    } catch (e) {
      console.warn('OCR skipped:', e.message);
    }

    const containsSpam = hasSpam(text);

    // phone number extraction same
    const matches = text.match(/\+?[0-9][0-9\s\-()]{7,}/g);
    const extracted = matches?.[0]?.trim() || 'Not Found';

    const doc = await AnalyzedScreenshot.create({
      imageUrl: result.secure_url,
      extractedNumber: extracted,
      time: new Date(),
      toNumber: req.body.toNumber || 'Unknown',
      carrier: req.body.carrier || 'Unknown',
      isSpam: containsSpam,
    });

    return res.status(201).json({
      success: true,
      data: {
        screenshotUrl: result.secure_url,
        extractedNumber: extracted,
        id: doc._id,
        time: doc.time,
        toNumber: doc.toNumber,
        carrier: doc.carrier,
        isSpam: doc.isSpam,
        // debug (optional): rawOCR: text
      },
    });
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
