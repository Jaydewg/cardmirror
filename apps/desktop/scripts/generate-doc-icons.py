#!/usr/bin/env python3
"""Generate document icons for the file associations.

macOS derives a document icon from the app icon when an association
ships none — and that derivation can fail reproducibly on some
machines, caching corrupted tiles for every .docx in Finder (field
report 2026-07-16; a cache flush did not fix it). Shipping explicit
icons bypasses derivation everywhere.

Outputs (into build/): docx.icns/.ico and cmir.icns/.ico — the names
electron-builder picks up automatically for fileAssociations by
extension. Regenerate after changing build/icon.png:

    python3 scripts/generate-doc-icons.py

The brand pipeline (scripts/gen-brand-assets.py at the repo root) calls it
with an explicit mark and output folder:

    python3 scripts/generate-doc-icons.py --mark <mark.png> --out <dir>

Design: standard macOS document-icon language — white portrait page
with a folded corner, the app mark centered, extension label
beneath.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BUILD = Path(__file__).resolve().parent.parent / "build"
MARK = BUILD / "icon.png"
CANVAS = 1024

def make_doc_icon(label: str, mark_path: Path = MARK) -> Image.Image:
    img = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Page: portrait, rounded, subtle border, folded top-right corner.
    left, top, right, bottom = 152, 32, 872, 992
    radius, fold = 44, 168
    border = (198, 198, 202, 255)
    white = (255, 255, 255, 255)
    foldc = (226, 226, 230, 255)

    d.rounded_rectangle([left, top, right, bottom], radius=radius, fill=white,
                        outline=border, width=6)
    # Fold: clip the top-right corner, redraw as a darker triangle.
    d.polygon([(right - fold, top - 3), (right + 3, top - 3),
               (right + 3, top + fold)], fill=(0, 0, 0, 0))
    d.polygon([(right - fold, top), (right, top + fold),
               (right - fold, top + fold)], fill=foldc, outline=border)
    d.line([(right - fold, top), (right - fold, top + fold)], fill=border, width=6)
    d.line([(right - fold, top + fold), (right, top + fold)], fill=border, width=6)

    # App mark, centered on the upper page body.
    mark = Image.open(mark_path).convert("RGBA").resize((430, 430), Image.LANCZOS)
    img.alpha_composite(mark, (int((CANVAS - 430) / 2), 270))

    # Extension label.
    font = None
    for cand in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf",
                 "/System/Library/Fonts/Supplemental/Arial.ttf",
                 "/System/Library/Fonts/Helvetica.ttc",
                 # Linux: Inter (the CardReflex text face), then DejaVu.
                 "/usr/share/fonts/opentype/inter/Inter-Bold.otf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"):
        try:
            font = ImageFont.truetype(cand, 108)
            break
        except OSError:
            continue
    if font is not None:
        tw = d.textlength(label, font=font)
        d.text(((CANVAS - tw) / 2, 770), label, font=font, fill=(120, 120, 126, 255))
    return img

def write_icns(img: Image.Image, out: Path) -> None:
    if shutil.which("iconutil") is None:
        # Not on macOS: Pillow writes the same icon sizes natively.
        img.resize((1024, 1024), Image.LANCZOS).save(out, format="ICNS")
        return
    with tempfile.TemporaryDirectory() as td:
        iconset = Path(td) / "doc.iconset"
        iconset.mkdir()
        for size in (16, 32, 64, 128, 256, 512):
            img.resize((size, size), Image.LANCZOS).save(iconset / f"icon_{size}x{size}.png")
            img.resize((size * 2, size * 2), Image.LANCZOS).save(
                iconset / f"icon_{size}x{size}@2x.png")
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(out)], check=True)

def write_ico(img: Image.Image, out: Path) -> None:
    img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--mark", type=Path, default=MARK, help="square app mark PNG")
    ap.add_argument("--out", type=Path, default=BUILD, help="output folder")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for ext, label in (("docx", "DOCX"), ("cmir", "CMIR")):
        icon = make_doc_icon(label, args.mark)
        write_icns(icon, args.out / f"{ext}.icns")
        write_ico(icon, args.out / f"{ext}.ico")
        print(f"generated {args.out / ext}.icns + .ico")

if __name__ == "__main__":
    sys.exit(main())
