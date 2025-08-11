const cloudinary = require('../config/cloudinary');
const tesseract = require('tesseract.js');
const sharp = require('sharp');
const AnalyzedScreenshot = require('../models/analyzedScreenshot');
const streamifier = require('streamifier');

const OCR_TIMEOUT_MS = 20_000; // avoid serverless timeouts
const TESS_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

// ---- helpers ----
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

// ---- controllers ----
const uploadScreenshot = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const folderName = `screenshots/${new Date().toISOString().split('T')[0]}`;

    // 1) compress buffer
    const compressedBuffer = await compressImageBuffer(req.file.buffer);

    // 2) upload to cloudinary
    const result = await streamUpload(compressedBuffer, folderName);

    // 3) OCR with timeout + CDN langPath (prevents long cold starts)
    let text = '';
    try {
      const ocrRes = await withTimeout(
        tesseract.recognize(compressedBuffer, 'eng', { langPath: TESS_LANG_PATH }),
        OCR_TIMEOUT_MS
      );
      text = ocrRes.data.text || '';
    } catch (e) {
      console.warn('OCR skipped:', e.message);
    }

    const containsSpam = /spam/i.test(text);
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
