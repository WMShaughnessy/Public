"""Make the small copies the Gallery's Thumbnails view shows.

For every photo in Gallery_images/, writes Gallery_thumbs/<blob SHA>.jpg:
512 px tall, turned upright, keeping only the colour profile (no location,
camera or date details). The name is the photo's git blob SHA, which
Gallery.html already gets from the GitHub listing, so a changed photo gets a
new copy and the page never shows a stale one. Copies whose photo is gone or
has changed are deleted.

Run by .github/workflows/gallery-thumbnails.yml after each push to main.
Needs Pillow (pip install pillow).
"""

import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageOps

IMAGES_DIR = "Gallery_images"
THUMBS_DIR = Path("Gallery_thumbs")
HEIGHT = 512                          # match THUMB_HEIGHT in Gallery_utils/Gallery_script.js
QUALITY = 85
BACKGROUND = (0xF2, 0xF2, 0xF2)       # tile colour (--stage) behind transparent photos
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"}

Image.MAX_IMAGE_PIXELS = None         # large panoramas are fine; the photos are our own


def photos():
    """(path, blob SHA) for every photo the page lists."""
    out = subprocess.run(
        ["git", "ls-files", "--stage", "-z", "--", IMAGES_DIR],
        check=True, capture_output=True,
    ).stdout.decode()
    for entry in filter(None, out.split("\0")):
        meta, path = entry.split("\t", 1)
        sha = meta.split()[1]
        parts = path.split("/")[1:]
        # Same rule as Gallery.html: hidden and unpublished names are skipped.
        if any(p.startswith((".", "_", "#", "~")) for p in parts):
            continue
        if Path(path).suffix.lower() in IMAGE_EXTS:
            yield path, sha


def make_thumbnail(src, dest):
    with Image.open(src) as im:
        icc = im.info.get("icc_profile") if im.mode != "CMYK" else None
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, BACKGROUND)
            flat.paste(im, mask=im.getchannel("A"))
            im = flat
        else:
            im = im.convert("RGB")
        if im.height > HEIGHT:
            width = max(1, round(im.width * HEIGHT / im.height))
            im = im.resize((width, HEIGHT), Image.Resampling.LANCZOS)
        tmp = dest.with_suffix(".part")
        try:
            im.save(tmp, "JPEG", quality=QUALITY, optimize=True, progressive=True, icc_profile=icc)
            tmp.replace(dest)
        finally:
            tmp.unlink(missing_ok=True)


def main():
    THUMBS_DIR.mkdir(exist_ok=True)
    wanted = set()
    made = failed = 0
    for path, sha in photos():
        dest = THUMBS_DIR / f"{sha}.jpg"
        wanted.add(dest.name)
        if dest.exists():
            continue
        try:
            make_thumbnail(path, dest)
            made += 1
            print(f"made    {dest}  ← {path}")
        except Exception as err:      # the page makes its own copy for this photo
            failed += 1
            print(f"skipped {path}: {err}", file=sys.stderr)

    removed = 0
    for old in THUMBS_DIR.glob("*.jpg"):
        if old.name not in wanted:
            old.unlink()
            removed += 1
            print(f"removed {old}")

    print(f"{len(wanted)} photos · {made} made · {removed} removed · {failed} skipped")


if __name__ == "__main__":
    main()
