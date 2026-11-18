"""Document generation for XeLaTeX.

A per-document build script uses a backend object B = docgen.backend() and only these calls:

  B.esc(text)                      escape plain text
  B.emph(markup) / B.strong(markup)
  B.code(s)                        inline code (typewriter, verbatim)
  B.cmd(name, *args)               call a macro defined in the per-document template.tex;
                                   each argument becomes {..}
  B.crop_args(page, bbox, *extra)  arguments for a crop macro (registers crops/<key>.pdf, see crops.py)
  B.code_block(text)               verbatim block (the text appears literally in the output file)
  B.heading(level, markup)         unnumbered heading (put the number into markup yourself)
  B.par(markup, indent=True)       paragraph
  B.footnote(markup) / B.link(url, markup)
  B.document(body, template)       wrap: input the template, begin/end document
  B.render(text, items, item_fn)   translator text (⟦n⟧ / `code` / <i>) -> markup
  B.write(body, template)          make crop files, write doc.tex; returns the file name
  B.compile(src, out_pdf)          run xelatex (twice)

Crop macros receive (file, x0, y0, x1, y1, ...) in original-page coordinates (pt, top-left origin)
via \\crop / \\icrop from common.tex.
Tr() looks up translations: overrides.json (src -> ja, hand fixes) first, then the model cache.
"""
import json, os, re, shutil, subprocess

import crops
from translate import key_of, load_cache


class Content(str):
    """Markup passed as a macro argument (kept for build scripts that mark content explicitly)."""


class Tr:
    """Translation lookup: overrides.json (src -> ja, hand fixes) first, then the model cache."""

    def __init__(self):
        self.cache = load_cache()
        self.ovr = json.load(open("overrides.json")) if os.path.exists("overrides.json") else {}
        self.missing = []

    def __call__(self, b):
        if b["src"] in self.ovr:
            return self.ovr[b["src"]]
        r = self.cache.get(key_of(b["src"]))
        if r is None:
            self.missing.append(b.get("id"))
            return b["src"]
        return r["ja"]


TOK = re.compile(r"`([^`]*)`|⟦(\d+)⟧|<i>|</i>")


class LaTeX:
    def render(self, text, items, item_fn):
        """Translator text -> markup. item_fn(item) renders a ⟦n⟧ placeholder. <i> nesting is counted
        as we go. Items the translator dropped are appended at the end so that nothing silently
        disappears; returns (markup, lost_keys)."""
        out, pos, used, depth, emph = [], 0, set(), 0, []
        for m in TOK.finditer(text):
            seg = self.esc(text[pos:m.start()])
            (emph if depth else out).append(seg)
            pos = m.end()
            tgt = emph if depth else out
            if m.group(1) is not None:
                tgt.append(self.code(m.group(1)))
            elif m.group(2):
                used.add(m.group(2))
                tgt.append(item_fn(items.get(m.group(2))))
            elif m.group(0) == "<i>":
                if depth == 0:
                    depth = 1; emph = []
            elif depth:
                out.append(self.emph("".join(emph))); depth = 0
        (emph if depth else out).append(self.esc(text[pos:]))
        if depth:
            out.append(self.emph("".join(emph)))
        lost = sorted(set(items) - used)
        for k in lost:
            out.append(" " + item_fn(items[k]))
        return "".join(out), lost

    def crop_args(self, page, bbox, *extra):
        return (crops.path(page, bbox), *[round(float(v), 2) for v in bbox], *extra)

    def write(self, body, template):
        crops.make()
        path = "doc.tex"
        open(path, "w").write(self.document(body, template))
        print("wrote", path)
        return path


    SPECIAL = set("\\{}$&#^_%~")

    def esc(self, s):
        return "".join("{\\char\"%02X}" % ord(c) if c in self.SPECIAL else c for c in s)

    def lit(self, v):
        if isinstance(v, bool): return "{true}" if v else "{false}"
        return "{" + str(v) + "}"

    def cmd(self, name, *args):
        return f"\\{name}" + ("".join(self.lit(a) for a in args) if args else "{}")

    def emph(self, m): return f"\\emph{{{m}}}"
    def strong(self, m): return f"\\textbf{{{m}}}"
    def code(self, s): return f"\\inlinecode{{{self.esc(s)}}}"
    def footnote(self, m): return f"\\footnote{{{m}}}"
    def link(self, url, m): return f"\\href{{{self.esc(url)}}}{{{m}}}"

    def code_block(self, text):
        return f"\\begin{{codeblock}}\n{text}\n\\end{{codeblock}}\n"

    def heading(self, level, m): return f"\n\\heading{'i' * level}{{{m}}}\n"
    def par(self, m, indent=True): return ("" if indent else "\\noindent ") + m + "\n"

    def document(self, body, template):
        return f"\\input{{{template}.tex}}\n\\begin{{document}}\n\\begindoc\n\n{body}\n\\end{{document}}\n"

    def compile(self, src, out_pdf):
        for _ in range(2):      # second run for float placement / labels
            r = subprocess.run(["xelatex", "-interaction=nonstopmode", "-halt-on-error", src],
                               capture_output=True, text=True)
            if r.returncode:
                print(r.stdout[-3000:]); raise SystemExit("xelatex failed")
        shutil.copy(src[:-4] + ".pdf", out_pdf)


def backend():
    return LaTeX()
