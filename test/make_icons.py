"""Regenerate icons/*.png. Run from the repo root: python3 test/make_icons.py"""
from PIL import Image, ImageDraw, ImageFont
import pathlib

FONT = "/usr/share/fonts/opentype/urw-base35/NimbusSans-Bold.otf"  # Helvetica clone; any bold sans works
ROOT = pathlib.Path(__file__).resolve().parent.parent

def icon(size):
    s = size * 8  # supersample
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=(17, 17, 17, 255))
    font = ImageFont.truetype(FONT, int(s * 0.66))
    bbox = d.textbbox((0, 0), "Aa", font=font)
    w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((s - w) / 2 - bbox[0] - s * 0.01, (s - h) / 2 - bbox[1]), "Aa", font=font, fill=(255, 255, 255, 255))
    return img.resize((size, size), Image.LANCZOS)

for n in (16, 32, 48, 128):
    icon(n).save(ROOT / "icons" / f"{n}.png")
print("ok")
