#!/usr/bin/env python3
"""usage: check.py OUT.pdf [doc.tex]   (run inside the work dir)

1. every translatable block has a translation; review-<model>.txt is empty
2. no English source sentence is hidden in the output PDF, and no crop file (crops/*.pdf, see
   crops.py) contains extractable text. Blocks of type "bib" (intentionally English) are skipped.
3. code blocks appear verbatim in doc.tex
5. rendering: mean page render time (mutool draw -stm) <= 3 x the source's (slow pages make text
   selection sluggish in viewers)
4. size: the output is not bloated (<= max(3 MB, 4 x the source)); whole outlined pages embedded
   as crops are the usual cause
"""
import json, os, re, subprocess, sys
from translate import TYPES, REVIEW, flat_blocks, load_cache, key_of

out_pdf = sys.argv[1]
typ = sys.argv[2] if len(sys.argv) > 2 else "doc.tex"
blocks = json.load(open("blocks.json"))
cache = load_cache()
ovr = json.load(open("overrides.json")) if os.path.exists("overrides.json") else {}
bad = 0

missing = [b.get("id") for b in flat_blocks(blocks)
           if b["type"] in TYPES and b.get("src") and b["src"] not in ovr and key_of(b["src"]) not in cache]
if missing:
    bad += 1; print(f"NG untranslated blocks: {missing[:20]}")
if os.path.exists(REVIEW) and open(REVIEW).read().strip():
    bad += 1; print(f"NG {REVIEW} is not empty (fix via overrides.json, then empty it)")

text = re.sub(r"\s+", " ", subprocess.run(["pdftotext", out_pdf, "-"], capture_output=True, text=True).stdout)
hits = []
for b in flat_blocks(blocks):
    if b["type"] not in TYPES or not b.get("src") or b["type"] == "bib":
        continue
    plain = re.sub(r"⟦\d+⟧|`[^`]*`|</?i>", "|", b["src"])
    ja = ovr.get(b["src"]) or cache.get(key_of(b["src"]), {}).get("ja", "")
    for frag in re.split(r"[|.;:]", plain):
        frag = frag.strip()
        # fragments kept in English on purpose (glossary terms, names) are also in the translation
        if len(frag) >= 30 and frag in text and frag.lower() not in ja.lower():
            hits.append((b.get("id"), frag)); break
if hits:
    bad += 1
    print(f"NG {len(hits)} English source fragments found in {out_pdf}, e.g. {hits[:3]}")

if os.path.isdir("crops"):
    texty = [f for f in sorted(os.listdir("crops")) if f.endswith(".pdf") and
             subprocess.run(["pdftotext", f"crops/{f}", "-"], capture_output=True, text=True).stdout.strip()]
    if texty:
        bad += 1; print(f"NG crop files with extractable text: {texty[:5]}")

src_pdf = os.environ.get("SRC_PDF")
if src_pdf and os.path.exists(src_pdf):
    o, s = os.path.getsize(out_pdf), os.path.getsize(src_pdf)
    if o > max(3e6, 4 * s):
        bad += 1; print(f"NG output is {o / 1e6:.1f} MB (source {s / 1e6:.1f} MB): are crops embedding whole pages?")

def render_ms(pdf):
    r = subprocess.run(["mutool", "draw", "-q", "-stm", "-r", "100", "-o", "/dev/null", "-F", "ppm", pdf],
                       capture_output=True, text=True)
    return [int(m) for m in re.findall(r"^page .* \d+ (\d+)ms\s*$", r.stderr + r.stdout, re.M)]


if src_pdf and os.path.exists(src_pdf):
    ts, to = render_ms(src_pdf), render_ms(out_pdf)
    if ts and to:
        ms, mo = sum(ts) / len(ts), sum(to) / len(to)
        worst = max(range(len(to)), key=lambda i: to[i])
        print(f"render: source {ms:.0f} ms/page, output {mo:.0f} ms/page (slowest: page {worst + 1}, {to[worst]} ms)")
        if mo > 3 * max(ms, 5):
            bad += 1; print("NG output renders > 3x slower than the source: look for heavy crops (overlays, "
                            "dense outlined text) and render them as text, or check fonts")

if os.path.exists(typ):
    t = open(typ).read()
    lost = [b.get("id") for b in flat_blocks(blocks) if b["type"] == "code" and b["text"] not in t]
    if lost:
        bad += 1; print(f"NG code blocks not verbatim in {typ}: {lost[:20]}")

print("OK" if not bad else f"{bad} problem(s)")
sys.exit(1 if bad else 0)
