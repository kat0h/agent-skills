"""Per-crop PDFs: small, vector, and without any (hidden) English text.

Including a page of the original PDF embeds the *whole* page, and clipping only hides the rest.
Cropping the original therefore smuggles its invisible English text into the output, and cropping a fully outlined
copy of the original makes the output huge (every glyph of every page becomes a path: 13 pages,
0.6MB -> 15.7MB). So for every crop we make crops/<key>.pdf:

  1. crops.js: one page of the original, everything outside the box (+PAD) removed by redaction
  2. gs -dNoOutputFonts: the few remaining glyphs become outlines (no extractable text)

The file keeps the original page size and coordinates, so the crop box is used unchanged with page 1.
Typical size: a few KB (inline math) to a few hundred KB (large plots).

docgen.crop_args() registers crops; docgen.write() calls make() before writing doc.tex.
"""
import hashlib, os, subprocess
from concurrent.futures import ThreadPoolExecutor

PAD = 2.0
DIR = "crops"
JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "crops.js")
JOBS = {}           # path -> (page, bbox)


def path(page, bbox):
    """Register a crop of page `page` (1-based), bbox (x0, y0, x1, y1) in pt; returns the file path."""
    bbox = tuple(round(float(v), 2) for v in bbox)
    key = hashlib.sha1(repr((os.environ.get("SRC_PDF", ""), page, bbox, PAD)).encode()).hexdigest()[:12]
    p = f"{DIR}/p{page}-{key}.pdf"
    JOBS[p] = (page, bbox)
    return p


def _make(item):
    out, (page, (x0, y0, x1, y1)) = item
    if os.path.exists(out):
        return
    tmp = out + ".raw.pdf"
    subprocess.run(["mutool", "run", JS, os.environ["SRC_PDF"], str(page),
                    str(x0 - PAD), str(y0 - PAD), str(x1 + PAD), str(y1 + PAD), tmp],
                   check=True, capture_output=True)
    # gs may warn about non-conforming originals; the output is fine
    subprocess.run(["gs", "-q", "-o", out + ".tmp", "-sDEVICE=pdfwrite", "-dNoOutputFonts", tmp],
                   check=True, capture_output=True)
    os.replace(out + ".tmp", out)
    os.remove(tmp)


def make(workers=8):
    os.makedirs(DIR, exist_ok=True)
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(_make, JOBS.items()))
    # drop stale files of earlier runs so that crops/ reflects doc.tex
    for f in os.listdir(DIR):
        if f"{DIR}/{f}" not in JOBS:
            os.remove(f"{DIR}/{f}")
    if JOBS:
        size = sum(os.path.getsize(p) for p in JOBS)
        print(f"crops: {len(JOBS)} files, {size / 1e6:.2f} MB")
