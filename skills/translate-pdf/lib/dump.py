#!/usr/bin/env python3
"""usage: dump.py A B   (run inside the work dir)

Print every mutool line of pages A..B as
  baseline  x0-x1 | [font size]text ...
Always measure geometry with this before writing extraction code.
"""
import sys
from stext import load_pages

a, b = int(sys.argv[1]), int(sys.argv[2])
for p in load_pages(".")[a - 1:b]:
    print(f"===== page {p['no']}  ({p['w']:.1f} x {p['h']:.1f})")
    for l in p["lines"]:
        s0 = l["spans"][0]
        print(f"{s0['base']:6.1f} {l['bbox'][0]:6.1f}-{l['bbox'][2]:6.1f} | "
              + " ".join(f"[{s['font']} {s['size']:.1f}]{s['text']}" for s in l["spans"]))
