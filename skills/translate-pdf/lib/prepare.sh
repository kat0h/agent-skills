#!/bin/sh
# usage: prepare.sh IN.pdf [WORK] [OUT.pdf]
#   Missing tools (mutool, gs, XeLaTeX + xeCJK + Harano Aji + TeX Gyre) are installed with nix.
#   WORK    default ${TMPDIR:-/tmp}/translate-tex-pdf/<stem>   (never the folder of IN.pdf)
#   OUT.pdf default <dir of IN.pdf>/<stem>_ja.pdf               (the only file written there)
# Checks/installs tools, writes WORK/env.sh, WORK/src.stext.xml, WORK/common.tex.
# (crop PDFs are made per crop by lib/crops.py when docgen writes doc.tex)
set -e
SKILL=$(cd "$(dirname "$0")/.." && pwd)
IN=$(realpath "$1")
STEM=$(basename "$IN" .pdf)
WORK=${2:-${TMPDIR:-/tmp}/translate-tex-pdf/$STEM}
OUT=${3:-$(dirname "$IN")/${STEM}_ja.pdf}
NIXDIR=${XDG_CACHE_HOME:-$HOME/.cache}/translate-tex-pdf/nix
mkdir -p "$WORK"
WORK=$(realpath "$WORK")

EXTRA_PATH=""
need_nix() {   # need_nix <gc-root-name> <flake-attr>
  command -v nix >/dev/null || { echo "ERROR: $2 is missing and nix is not installed; ask the user to install it" >&2; exit 1; }
  mkdir -p "$NIXDIR"
  ls -d "$NIXDIR/$1"* >/dev/null 2>&1 || nix build -o "$NIXDIR/$1" "$2"   # .bin outputs get a -bin suffix
}
command -v mutool >/dev/null || { need_nix mupdf nixpkgs#mupdf.bin; EXTRA_PATH="$NIXDIR/mupdf-bin/bin:$EXTRA_PATH"; }
command -v gs >/dev/null || { need_nix gs nixpkgs#ghostscript; EXTRA_PATH="$NIXDIR/gs/bin:$EXTRA_PATH"; }
if ! command -v xelatex >/dev/null; then
  command -v nix >/dev/null || { echo "ERROR: xelatex is missing and nix is not installed" >&2; exit 1; }
  mkdir -p "$NIXDIR"
  [ -e "$NIXDIR/texlive" ] || nix build --impure -o "$NIXDIR/texlive" --expr 'with import <nixpkgs> {}; texliveBasic.withPackages (ps: with ps; [ xetex fontspec xecjk haranoaji tex-gyre lm graphics tools extsizes geometry fancyvrb xcolor hyperref url etoolbox l3kernel l3packages caption float zref xkeyval ])'
  EXTRA_PATH="$NIXDIR/texlive/bin:$EXTRA_PATH"
fi

cat > "$WORK/env.sh" <<EOF
export PATH="$EXTRA_PATH\$PATH"
export PYTHONPATH="$SKILL/lib"
export PYTHONDONTWRITEBYTECODE=1
export SKILL="$SKILL"
export SRC_PDF="$IN"
export OUT_PDF="$OUT"
EOF
. "$WORK/env.sh"
[ -f "$WORK/src.stext.xml" ] || mutool draw -q -F stext -o "$WORK/src.stext.xml" "$IN"
cp "$SKILL/template/common.tex" "$WORK/"
echo "WORK=$WORK"
echo "OUT=$OUT"
