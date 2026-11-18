"""Parse `mutool draw -F stext` XML into pages -> lines -> spans (font, size, text, bbox).

load_pages(work) parses $WORK/src.stext.xml once and caches it as $WORK/pages.pickle.
"""
import os, pickle
import xml.etree.ElementTree as ET


def load(path):
    pages = []
    cur = None
    for ev, el in ET.iterparse(path, events=("start", "end")):
        if ev == "start" and el.tag == "page":
            cur = {"no": len(pages) + 1, "w": float(el.get("width")), "h": float(el.get("height")), "lines": []}
        elif ev == "end" and el.tag == "line":
            spans = []
            for f in el.findall("font"):
                name, size = f.get("name"), float(f.get("size"))
                chars = [(c.get("c"), float(c.get("x")), float(c.get("y")), [float(v) for v in c.get("quad").split()])
                         for c in f.findall("char")]
                if not chars:
                    continue
                x0 = min(q[0] for _, _, _, q in chars); x1 = max(q[2] for _, _, _, q in chars)
                y0 = min(q[1] for _, _, _, q in chars); y1 = max(q[5] for _, _, _, q in chars)
                spans.append({"font": name, "size": round(size, 2), "text": "".join(c for c, *_ in chars),
                              "x0": x0, "x1": x1, "y0": y0, "y1": y1, "base": chars[0][2],
                              "chars": [(c, x) for c, x, *_ in chars]})
            if spans:
                cur["lines"].append({"bbox": [float(v) for v in el.get("bbox").split()], "spans": spans})
            el.clear()
        elif ev == "end" and el.tag == "page":
            pages.append(cur)
            el.clear()
    return pages


def load_pages(work="."):
    xml = os.path.join(work, "src.stext.xml")
    cache = os.path.join(work, "pages.pickle")
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(xml):
        return pickle.load(open(cache, "rb"))
    pages = load(xml)
    pickle.dump(pages, open(cache, "wb"))
    return pages
