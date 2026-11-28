#!/usr/bin/env python3
"""Render a brand profile's icons from its SVG marks.

    python3 scripts/gen-brand-assets.py cardreflex

Reads brand/<id>/brand.json, brand/<id>/mark.svg and brand/<id>/mark-small.svg
(the small mark is used at 48 px and below, where the full mark's tag lines
blur). Writes everything into brand/<id>/generated/, which is committed, so
builds and CI never need image tools. scripts/apply-brand.mjs then copies the
active profile's outputs to where the build expects them.

Run locally after changing a mark. Needs: inkscape (SVG rendering), icotool
(multi-resolution .ico), Pillow (compositing, .icns). Python only, no
installs beyond those tools.

Outputs (paths under generated/):
  desktop/icon.png            1024 px app icon (electron-builder: mac/linux)
  desktop/icon.ico            16-256 px Windows app icon
  desktop/icons/NxN.png       Linux icon set (16 ... 1024)
  desktop/{cmir,docx}.{ico,icns}   document icons (apps/desktop/scripts/
                              generate-doc-icons.py, with this mark)
  msix-tiles/*.png            Microsoft Store (MSIX) package tiles; apply-brand
                              copies them to apps/desktop/build/appx/, the
                              folder electron-builder reads MSIX tiles from
  public/*.png                web favicon, apple-touch, PWA icons
  file-mark-48.png            status-bar file drag handle / drag image
  readme/lockup-{light,dark}.png   README header (mark + name + lineage)
"""

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DOC_ICONS = ROOT / "apps" / "desktop" / "scripts" / "generate-doc-icons.py"
SMALL_MAX = 48  # sizes at or below this render from mark-small.svg


def need(tool: str) -> str:
    path = shutil.which(tool)
    if path is None:
        sys.exit(f"gen-brand-assets: '{tool}' not found on PATH")
    return path


def hex_rgba(color: str) -> tuple[int, int, int, int]:
    c = color.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), 255)


class Renderer:
    """Renders the marks at exact pixel sizes (cached per size + variant)."""

    def __init__(self, brand_dir: Path, tmp: Path) -> None:
        self.full = brand_dir / "mark.svg"
        small = brand_dir / "mark-small.svg"
        self.small = small if small.exists() else self.full
        self.tmp = tmp
        self.inkscape = need("inkscape")
        self.cache: dict[tuple[str, int], Path] = {}

    def png(self, size: int, variant: str | None = None) -> Path:
        variant = variant or ("small" if size <= SMALL_MAX else "full")
        key = (variant, size)
        if key not in self.cache:
            src = self.small if variant == "small" else self.full
            out = self.tmp / f"{variant}-{size}.png"
            subprocess.run(
                [self.inkscape, str(src), "-w", str(size), "-h", str(size), "-o", str(out)],
                check=True,
                capture_output=True,
            )
            self.cache[key] = out
        return self.cache[key]

    def image(self, size: int, variant: str | None = None) -> Image.Image:
        return Image.open(self.png(size, variant)).convert("RGBA")


def centered(canvas: tuple[int, int], mark: Image.Image, bg=(0, 0, 0, 0)) -> Image.Image:
    img = Image.new("RGBA", canvas, bg)
    img.alpha_composite(mark, ((canvas[0] - mark.width) // 2, (canvas[1] - mark.height) // 2))
    return img


# README / repo lockup: mark + wordmark + lineage line, one PNG per GitHub
# colour scheme (README.md switches them with <picture>). The lineage line
# follows the home screen's rule (.pmd-home-lineage): light italic, ~37% of
# the wordmark size, muted.
LOCKUP_SCHEMES = {
    "light": {"ink": "#15171C", "muted": "#5B606B"},
    "dark": {"ink": "#F2F3F5", "muted": "#9AA0AA"},
}


def readme_lockups(brand_dir: Path, brand: dict, out: Path, inkscape: str, tmp: Path) -> None:
    import re

    mark_svg = (brand_dir / "mark.svg").read_text()
    inner = re.sub(r"^.*?<svg[^>]*>|</svg>\s*$", "", mark_svg, flags=re.S)
    lineage = brand.get("lineage", "")
    dest = out / "readme"
    dest.mkdir(parents=True, exist_ok=True)
    for scheme, c in LOCKUP_SCHEMES.items():
        text_y = 66 if lineage else 76
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 120" width="640" height="120">
  <g transform="translate(0 10)">{inner}</g>
  <text x="122" y="{text_y}" font-family="Inter" font-weight="700" font-size="56"
        letter-spacing="-0.56" fill="{c['ink']}">{brand['productName']}</text>
  {f'<text x="124" y="100" font-family="Inter" font-style="italic" font-weight="300" font-size="21" letter-spacing="0.2" fill="{c["muted"]}">{lineage}</text>' if lineage else ''}
</svg>"""
        src = tmp / f"lockup-{scheme}.svg"
        src.write_text(svg)
        png = tmp / f"lockup-{scheme}.png"
        subprocess.run([inkscape, str(src), "-w", "1280", "-o", str(png)], check=True, capture_output=True)
        img = Image.open(png).convert("RGBA")
        img.crop(img.getchannel("A").getbbox()).save(dest / f"lockup-{scheme}.png")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: gen-brand-assets.py <brand-id>")
    brand_id = sys.argv[1]
    brand_dir = ROOT / "brand" / brand_id
    brand = json.loads((brand_dir / "brand.json").read_text())
    if not (brand_dir / "mark.svg").exists():
        sys.exit(f"gen-brand-assets: {brand_dir / 'mark.svg'} missing (this profile has no SVG source)")
    tile_bg = hex_rgba(brand["tileBackground"])
    out = brand_dir / "generated"
    icotool = need("icotool")

    with tempfile.TemporaryDirectory() as td:
        r = Renderer(brand_dir, Path(td))

        # ── Desktop app icons ──
        desk = out / "desktop"
        (desk / "icons").mkdir(parents=True, exist_ok=True)
        shutil.copy(r.png(1024), desk / "icon.png")
        for size in (16, 24, 32, 48, 64, 96, 128, 256, 512, 1024):
            shutil.copy(r.png(size), desk / "icons" / f"{size}x{size}.png")
        ico_sizes = (16, 24, 32, 48, 64, 128, 256)
        subprocess.run(
            [icotool, "-c", "-o", str(desk / "icon.ico")] + [str(r.png(s)) for s in ico_sizes],
            check=True,
        )
        # Document icons: the existing page-with-fold design, this mark.
        subprocess.run(
            [sys.executable, str(DOC_ICONS), "--mark", str(r.png(1024)), "--out", str(desk)],
            check=True,
        )

        # ── Microsoft Store (MSIX) tiles ──
        # The mark carries its own rounded signal tile; Windows plates the
        # tiles on `tileBackground` (appx.backgroundColor), so the larger
        # tiles centre the mark with breathing room.
        appx = out / "msix-tiles"
        appx.mkdir(parents=True, exist_ok=True)
        r.image(50).save(appx / "StoreLogo.png")
        r.image(44).save(appx / "Square44x44Logo.png")
        centered((71, 71), r.image(48)).save(appx / "SmallTile.png")
        centered((150, 150), r.image(100)).save(appx / "Square150x150Logo.png")
        centered((310, 150), r.image(100)).save(appx / "Wide310x150Logo.png")
        centered((310, 310), r.image(200)).save(appx / "LargeTile.png")
        centered((620, 300), r.image(200), tile_bg).save(appx / "SplashScreen.png")

        # ── Web / PWA ──
        pub = out / "public"
        pub.mkdir(parents=True, exist_ok=True)
        r.image(48).save(pub / "favicon.png")
        r.image(192).save(pub / "pwa-192.png")
        r.image(512).save(pub / "pwa-512.png")
        # iOS and maskable icons get a full-bleed square ground: iOS paints
        # transparent corners black, and maskable icons are cropped to the
        # platform's shape (the mark stays inside the 80% safe zone).
        centered((180, 180), r.image(180), tile_bg).save(pub / "apple-touch-icon.png")
        centered((512, 512), r.image(400), tile_bg).save(pub / "pwa-maskable-512.png")

        # ── Status-bar file mark (drag handle + drag image) ──
        r.image(48, "small").save(out / "file-mark-48.png")

        # ── README lockups (light + dark) ──
        readme_lockups(brand_dir, brand, out, r.inkscape, Path(td))

    print(f"gen-brand-assets: wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
