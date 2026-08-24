#!/usr/bin/env python3
"""Build dist/deserif.zip with only the files the extension needs."""
import pathlib, zipfile

ROOT = pathlib.Path(__file__).resolve().parent
FILES = ["manifest.json", "content.js", "slop.js", "background.js", "popup.html", "popup.js",
         "icons/16.png", "icons/32.png", "icons/48.png", "icons/128.png", "README.md", "LICENSE"]
out = ROOT / "dist" / "deserif.zip"
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in FILES:
        z.write(ROOT / f, f"deserif/{f}")
print(out)
