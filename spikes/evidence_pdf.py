"""Writes a one-page PDF evidence pack (no dependencies) for the H4 dispute spike: argv[1] = output path,
remaining argv = lines of text. In v2 the pack is rendered from ledger events; this proves the upload path."""
import sys

out, lines = sys.argv[1], sys.argv[2:]
esc = lambda s: s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
text = "BT /F1 11 Tf 50 790 Td 14 TL " + " ".join(f"({esc(l)}) '" for l in lines) + " ET"
objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    f"<< /Length {len(text)} >>\nstream\n{text}\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
pdf, offsets = b"%PDF-1.4\n", []
for i, o in enumerate(objs, 1):
    offsets.append(len(pdf))
    pdf += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
xref = len(pdf)
pdf += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
pdf += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
open(out, "wb").write(pdf)
