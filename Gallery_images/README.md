# Gallery Photos

Everything in this folder shows up on `Gallery.html` automatically — push the
files and the page picks them up (the folder listing is cached for 15 minutes;
use **↻ Refresh** on the page to check sooner).

The live site reads this folder **on the `main` branch** — photos on another
branch, or only on your computer, won't appear there until they're merged or
pushed to `main`.

Opening `Gallery.html` straight from your computer also works: the photo
list, captions and dates come from GitHub (`main`), and the images display
from your local copy.

To preview photos you haven't pushed yet, run a web server in the repo folder
and open `http://localhost:8000/Gallery.html` — the page then lists your local
`Gallery_images/` instead:

```
python3 -m http.server 8000
```

## Layout

```
Gallery_images/
  gallery.json          ← titles, captions and tags for every photo (optional)
  sunset.jpg
  Iceland 2025/         ← a subfolder is an album
    glacier.jpg            every photo inside gets the tag "Iceland 2025"
```

- Photo types: `.jpg` `.jpeg` `.png` `.webp` `.gif` `.avif`
- File or folder names starting with `.` or `_` are ignored (GitHub Pages
  does not publish them).

## gallery.json

One file for the whole gallery. Each photo is listed by file name; photos
not listed simply show without a caption. Every field is optional:

```json
{
  "sunset.jpg": {
    "title": "Sunset over the Hudson",
    "caption": "From Pier 45, just after the rain.",
    "tags": ["NYC", "Sunset", "Water"]
  },
  "Iceland 2025/glacier.jpg": {
    "caption": "Sólheimajökull.\nSecond line of the caption.",
    "tags": ["Ice", "Water"],
    "date": "2025-03-01 10:00"
  },
  "IMG_4411.jpg": "A caption on its own can be written as plain text."
}
```

- **Names** — the path inside `Gallery_images/`. For photos in an album,
  the file name alone (`"glacier.jpg"`) also works as long as no other photo
  has the same name. Upper/lower case doesn't matter.
- **Caption** — `\n` starts a new line (or give a list of lines).
- **Tags** — a list, or one comma-separated string (`"NYC, Sunset"`). The
  album folder name is added automatically.
- **Date** — only needed to override the photo. `YYYY-MM-DD`, optionally
  followed by `HH:MM`.
- JSON is strict: quote every name and value, put commas between entries,
  and no comma after the last one. If the file has a mistake, or lists a
  name that matches no photo, the gallery shows a warning above the photos
  instead of breaking.

## Dates

The date is read from the photo's metadata (EXIF "Date Taken"), so keep that
field when cleaning the other details. If it's missing, the page falls back to
a date in the file name (e.g. `IMG_20240512_184207.jpg`). A photo with no
date shows without one and is placed after the dated photos.

Any field a photo doesn't have (date, title, caption, tags) is simply left
off — nothing is shown in its place.
