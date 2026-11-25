// usage: mutool run crops.js IN.pdf PAGE x0 y0 x1 y1 OUT.pdf      (pt, top-left origin)
// Writes a one-page PDF (same page size and coordinates as PAGE of IN.pdf) in which everything
// outside the box has been removed by redaction: text, images and line art lying wholly outside.
// crops.py then converts the remaining text to outlines (gs -dNoOutputFonts).
var a = scriptArgs;
var doc = new PDFDocument(a[0]);
var pno = parseInt(a[1]) - 1;
var x0 = +a[2], y0 = +a[3], x1 = +a[4], y1 = +a[5];
for (var i = doc.countPages() - 1; i >= 0; i--)
  if (i != pno) doc.deletePage(i);
var page = doc.loadPage(0);
var b = page.getBounds();
var rects = [[b[0], b[1], b[2], y0], [b[0], y1, b[2], b[3]], [b[0], y0, x0, y1], [x1, y0, b[2], y1]];
for (var k = 0; k < rects.length; k++) {
  var r = rects[k];
  if (r[2] - r[0] <= 0 || r[3] - r[1] <= 0) continue;
  page.createAnnotation("Redact").setRect(r);
}
// applyRedactions(blackBoxes = false,
//   imageMethod 2 = blank the covered pixels (an image reaching into the box keeps its visible part),
//   lineArtMethod 1 = remove paths fully covered (paths crossing the box edge are clipped when included),
//   textMethod 0 = remove covered text)
page.applyRedactions(false, 2, 1, 0);
doc.save(a[6], "garbage=4,compress");
