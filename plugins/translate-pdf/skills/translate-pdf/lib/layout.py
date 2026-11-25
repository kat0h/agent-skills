"""Document-independent helpers for turning stext pages into rows and inline tokens.

Everything that depends on a particular document (margins, fonts -> categories, line
classification, block grouping) belongs in the per-document extract.py, not here.
"""
import re, unicodedata

SENT_END = (".", ":", "!", "?", ".)", ".”", ".]")


def line_text(spans):
    out, prev = "", None
    for s in spans:
        if prev is not None and s["x0"] - prev["x1"] > 0.8 and not out.endswith(" ") and not s["text"].startswith(" "):
            out += " "
        out += s["text"]
        prev = s
    return out


def merge_lines(page, keep=None, big=10.5, tol=2.0):
    """Merge mutool lines sharing a baseline (|d| < tol) into rows sorted top to bottom.

    keep(span) -> bool drops spans (line numbers, ...) before merging.
    Spans smaller than `big` in a row that also has big spans get script = "sup"/"sub".
    """
    rows = []
    for l in page["lines"]:
        sp = [s for s in l["spans"] if keep is None or keep(s)]
        if not sp:
            continue
        b = ([s for s in sp if s["size"] >= big] or sp)[0]["base"]
        for r in rows:
            if abs(r["base"] - b) < tol:
                r["spans"].extend(sp)
                break
        else:
            rows.append({"base": b, "spans": list(sp)})
    for r in rows:
        r["spans"].sort(key=lambda s: s["x0"])
        r["x0"] = min(s["x0"] for s in r["spans"]); r["x1"] = max(s["x1"] for s in r["spans"])
        r["y0"] = min(s["y0"] for s in r["spans"]); r["y1"] = max(s["y1"] for s in r["spans"])
        r["page"] = page["no"]
        r["text"] = line_text(r["spans"]).strip()
        has_big = any(x["size"] >= big for x in r["spans"])
        for s in r["spans"]:
            s["script"] = None
            if has_big and s["size"] < big:
                if s["base"] < r["base"] - 1.5: s["script"] = "sup"
                elif s["base"] > r["base"] + 0.5: s["script"] = "sub"
    rows.sort(key=lambda r: r["base"])
    return rows


ACCENT = {"´": "́", "`": "̀", "¨": "̈", "ˆ": "̂", "˜": "̃", "¸": "̧"}


def norm_text(t):
    """Ligatures -> NFKC; TeX spacing accents before a letter ("Gr¨ave") -> combined ("Gräve")."""
    if any(0xFB00 <= ord(c) <= 0xFB06 for c in t):
        t = unicodedata.normalize("NFKC", t)
    t = re.sub("([´`¨ˆ˜])([A-Za-z])", lambda m: unicodedata.normalize("NFC", m.group(2) + ACCENT[m.group(1)]), t)
    return t.replace("（", " (").replace("）", ") ")


def tt_text(t):
    """Typewriter text: curly quotes back to ASCII."""
    return t.replace("’", "'").replace("‘", "`")


def collect_hyph_words(rows, is_text):
    """Pairs 'a-b' that occur hyphenated *inside* a line somewhere in the document."""
    words = set()
    for r in rows:
        for s in r["spans"]:
            if is_text(s):
                for w in re.findall(r"[A-Za-z]+(?:-[A-Za-z]+)+", s["text"]):
                    ps = w.split("-")
                    for a, b in zip(ps, ps[1:]):
                        words.add((a + "-" + b).lower())
    return words


def dehyphenate(toks, hyph, textcats="RI"):
    """toks: dicts with cat, text, gap ("nl" marks the first token of a new line).
    Drops a line-final '-' unless the hyphenated form occurs mid-line elsewhere or the next part is
    capitalised (e.g. a compound of acronyms). Afterwards gap is a plain bool."""
    for i, t in enumerate(toks):
        if t["gap"] != "nl":
            continue
        p = toks[i - 1] if i else None
        if p and p["cat"] in textcats and t["cat"] in textcats and p["text"].endswith("-") \
                and not p["text"].endswith("--") and t["text"][:1].isalpha():
            pre = re.search(r"([A-Za-z]+)-$", p["text"]); post = re.match(r"[A-Za-z]+", t["text"])
            keep = (pre and post and (pre.group(1) + "-" + post.group(0)).lower() in hyph) or t["text"][:1].isupper()
            if not keep:
                p["text"] = p["text"][:-1]
            t["gap"] = False
        else:
            t["gap"] = True
    return toks


def ends_sentence(row, is_text):
    sp = [x for x in row["spans"] if x["text"].strip()]
    return bool(sp) and is_text(sp[-1]) and row["text"].rstrip().endswith(SENT_END)


# parenthetical author-year citations: (Smith et al., 2009; Doe, 2016)
CITE = re.compile(r"\((?:[^()⟦⟧;]*?,\s*\d{4}[a-z]?)(?:;\s*[^()⟦⟧;]*?,\s*\d{4}[a-z]?)*\)")


def protect(src, items, regex, kind="cite"):
    """Replace regex matches in src by new ⟦n⟧ items, then renumber all placeholders in order."""
    def sub(m):
        k = str(len(items) + 1 + sub.n); sub.n += 1
        new[k] = {"kind": kind, "text": m.group(0)}
        return f"⟦{k}⟧"
    sub.n, new = 0, {}
    src = regex.sub(sub, src)
    items = {**items, **new}
    order = re.findall(r"⟦(\d+)⟧", src)
    remap = {old: str(i + 1) for i, old in enumerate(order)}
    src = re.sub(r"⟦(\d+)⟧", lambda m: f"⟦{remap[m.group(1)]}⟧", src)
    return src, {remap[k]: v for k, v in items.items() if k in remap}


def inline_crop(row, spans, pad=0.3, gap=0.15):
    """Crop rectangle for a run of spans (inline math etc.) on one row.
    Padded by `pad`, but clamped so that it never reaches into the neighbouring glyphs of the row
    (otherwise slivers of adjacent letters show up at the crop edges)."""
    x0 = min(s["x0"] for s in spans) - pad; x1 = max(s["x1"] for s in spans) + pad
    rs = row["spans"]; a = rs.index(spans[0]); z = rs.index(spans[-1])
    if a > 0: x0 = max(x0, rs[a - 1]["x1"] + gap)
    if z + 1 < len(rs): x1 = min(x1, rs[z + 1]["x0"] - gap)
    return {"page": row["page"], "base": round(row["base"], 2),
            "bbox": [round(x0, 2), round(min(s["y0"] for s in spans) - pad, 2),
                     round(x1, 2), round(max(s["y1"] for s in spans) + pad, 2)],
            "text": "".join(s["text"] for s in spans)}
