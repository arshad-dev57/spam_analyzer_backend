import sys, io, json, argparse, os
import easyocr
from PIL import Image

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stdin", action="store_true")
    ap.add_argument("--image", type=str)
    ap.add_argument("--lang", default="en")
    ap.add_argument("--fast", action="store_true")
    args = ap.parse_args()

    langs = [s.strip() for s in args.lang.split(",") if s.strip()]

    # Persist models in project (or override via env)
    model_dir = os.environ.get("EASYOCR_MODEL_DIR") or os.path.join(os.getcwd(), ".easyocr_models")
    os.makedirs(model_dir, exist_ok=True)

    try:
        reader = easyocr.Reader(
            langs, gpu=False, quantize=False, model_storage_directory=model_dir
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"init_failed: {e}", "model_dir": model_dir}))
        sys.exit(1)

    def run_bytes(img_bytes: bytes):
        if args.fast:
            result = reader.readtext(img_bytes, detail=0, paragraph=False)
            texts = [t for t in result if isinstance(t, str)]
            return {"ok": True, "text": "\n".join(texts), "count": len(texts), "fast": True}
        else:
            result = reader.readtext(img_bytes, detail=1, paragraph=True)
            texts = [r[1] for r in result if isinstance(r, (list, tuple)) and len(r) >= 2]
            confs = [r[2] for r in result if isinstance(r, (list, tuple)) and len(r) >= 3 and isinstance(r[2], (int, float))]
            avg_conf = (sum(confs)/len(confs) if confs else None)
            return {"ok": True, "text": "\n".join(texts), "count": len(texts), "avg_conf": avg_conf, "fast": False}

    try:
        if args.stdin:
            raw = sys.stdin.buffer.read()
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            buf = io.BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
            out = run_bytes(buf.getvalue())
        else:
            if not args.image:
                print(json.dumps({"ok": False, "error": "No input", "model_dir": model_dir})); sys.exit(1)
            # Pass path or bytes; EasyOCR accepts path directly too
            out = run_bytes(args.image)
        out["model_dir"] = model_dir
        print(json.dumps(out, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"read_failed: {e}", "model_dir": model_dir}))
        sys.exit(1)

if __name__ == "__main__":
    main()
