#!/usr/bin/env python3
"""blocks.json -> translations-<model>.jsonl  (run inside the work dir; cache keyed by source hash, resumable)

usage: translate.py [--workers N] [--retry-failed]

Document-specific settings live in ./config.json:
  {"url": "http://HOST:PORT/v1/chat/completions",   # env PLAMO_URL overrides
   "model": "plamo",                       # label for the cache file names; env MODEL overrides
   "types": ["para", "caption", ...],      # block types that carry a translatable "src"
   "glossary": [["term", "訳語"], ...]}
Blocks of type "float" may hold nested blocks in "parts"; they are translated too.
API key: env PLAMO_API_KEY, else the file $PLAMO_API_KEY_FILE (default ~/.config/plamo-api-key).
"""
import argparse, hashlib, json, os, re, time, urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

CONF = json.load(open("config.json")) if os.path.exists("config.json") else {}
MODEL = os.environ.get("MODEL") or CONF.get("model", "plamo")
URL = os.environ.get("PLAMO_URL") or CONF.get("url", "")
_KEYFILE = os.path.expanduser(os.environ.get("PLAMO_API_KEY_FILE", "~/.config/plamo-api-key"))
API_KEY = os.environ.get("PLAMO_API_KEY") or (open(_KEYFILE).read().strip() if os.path.exists(_KEYFILE) else "")
HEADERS = {"Content-Type": "application/json"}
if API_KEY:
    HEADERS["Authorization"] = f"Bearer {API_KEY}"
CACHE = f"translations-{MODEL}.jsonl"
REVIEW = f"review-{MODEL}.txt"
VERSION = CONF.get("version", "v1")
TYPES = tuple(CONF.get("types", ["title", "abstract", "keywords", "para", "caption", "heading", "footnote"]))
GLOSSARY = [tuple(g) for g in CONF.get("glossary", [])]


def key_of(src):
    return hashlib.sha1((VERSION + "\0" + src).encode()).hexdigest()[:16]


def flat_blocks(blocks):
    for b in blocks:
        yield from (b["parts"] if b["type"] == "float" else [b])


def load_cache():
    tr = {}
    if os.path.exists(CACHE):
        for line in open(CACHE):
            r = json.loads(line)
            tr[r["key"]] = r
    return tr


def call(text, temperature):
    low = text.lower()
    gl = [{"source": a, "target": b} for a, b in GLOSSARY if re.search(r"\b" + re.escape(a.lower()) + r"\b", low)]
    kw = {"form": "plain", "source_lang": "en"}
    if gl:
        kw["glossary"] = gl
    body = {"messages": [{"role": "user", "content": text}], "temperature": temperature,
            "max_tokens": 4096, "chat_template_kwargs": kw}
    req = urllib.request.Request(URL, json.dumps(body).encode(), HEADERS)
    with urllib.request.urlopen(req, timeout=600) as r:
        d = json.load(r)
    return d["choices"][0]["message"]["content"].strip()


PH = re.compile(r"⟦(c?\d+)⟧")
BT = re.compile(r"`([^`]*)`")


def check(src, out):
    errs = []
    want, got = Counter(PH.findall(src)), Counter(PH.findall(out))
    if want != got:
        errs.append(f"placeholders {dict(want)} != {dict(got)}")
    # the same code may be repeated (natural in Japanese), but none may be lost or invented
    if set(BT.findall(src)) != set(BT.findall(out)):
        errs.append("code spans differ")
    if out.count("`") % 2:
        errs.append("odd backticks")
    if not out:
        errs.append("empty")
    return errs


def fix_tags(out):
    if out.count("<i>") != out.count("</i>"):
        out = out.replace("<i>", "").replace("</i>", "")
    return out


def translate(src):
    """-> (ja, ok, log)"""
    log = []
    for t, temp in enumerate((0.0, 0.3, 0.6)):
        out = fix_tags(call(src, temp))
        e = check(src, out)
        if not e:
            return out, True, log
        log.append(f"try{t}: {'; '.join(e)} :: {out}")
    codes = []      # fallback: protect code spans as placeholders too

    def sub(m):
        codes.append(m.group(1))
        return f"⟦c{len(codes)}⟧"
    src2 = BT.sub(sub, src)
    for t, temp in enumerate((0.0, 0.4)):
        out = fix_tags(call(src2, temp))
        e = check(src2, out)
        if not e:
            out = PH.sub(lambda m: f"`{codes[int(m.group(1)[1:]) - 1]}`" if m.group(1).startswith("c") else m.group(0), out)
            return out, True, log
        log.append(f"fallback{t}: {'; '.join(e)} :: {out}")
    return out, False, log


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=1, help="= total_slots of the server")
    ap.add_argument("--retry-failed", action="store_true")
    a = ap.parse_args()
    if not URL:
        raise SystemExit("set the server URL: env PLAMO_URL or \"url\" in config.json")
    blocks = json.load(open("blocks.json"))
    done = load_cache()
    todo, seen = [], set()
    for b in flat_blocks(blocks):
        if b["type"] not in TYPES or not b.get("src"):
            continue
        k = key_of(b["src"])
        if k in seen:
            continue
        seen.add(k)
        if k in done and (done[k]["ok"] or not a.retry_failed):
            continue
        todo.append((k, b))
    print(f"{MODEL}: {len(seen)} unique sources, {len(seen) - len(todo)} cached, {len(todo)} to do", flush=True)
    t0 = time.time()
    fo, fr = open(CACHE, "a"), open(REVIEW, "a")

    def work(kb):
        k, b = kb
        try:
            ja, ok, log = translate(b["src"])
        except Exception as ex:
            return k, b, None, False, [f"error: {ex}"]
        return k, b, ja, ok, log

    n = 0
    with ThreadPoolExecutor(a.workers) as ex:
        for k, b, ja, ok, log in ex.map(work, todo):
            n += 1
            if ja is not None:
                fo.write(json.dumps({"key": k, "id": b.get("id"), "src": b["src"], "ja": ja, "ok": ok}, ensure_ascii=False) + "\n")
                fo.flush()
            if not ok:
                fr.write(f"== {b.get('id')} ({b['type']}, page {b.get('page')})\nSRC: {b['src']}\n" + "\n".join(log) + "\n\n")
                fr.flush()
            if n % 10 == 0 or n == len(todo):
                el = time.time() - t0
                print(f"[{n}/{len(todo)}] {el:.0f}s, eta {el / n * (len(todo) - n):.0f}s", flush=True)


if __name__ == "__main__":
    main()
