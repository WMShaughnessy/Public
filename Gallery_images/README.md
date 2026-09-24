# Gallery Photos

Everything in this folder shows up on `Gallery.html` automatically — push the
files and the page picks them up (the folder listing is cached for 15 minutes;
use **↻ Refresh** on the page to check sooner).

## Layout

```
Gallery_images/
  sunset.jpg            ← a photo
  sunset.txt            ← optional caption/tag file (same name, .txt)
  Iceland 2025/         ← a subfolder is an album
    glacier.jpg            every photo inside gets the tag "Iceland 2025"
    glacier.txt
```

- Photo types: `.jpg` `.jpeg` `.png` `.webp` `.gif` `.avif`
- File or folder names starting with `.` or `_` are ignored (GitHub Pages
  does not publish them).

## Caption / tag file

Plain text, same name as the photo with `.txt` (`sunset.txt` or
`sunset.jpg.txt`). Every line is optional:

```
Title: Sunset over the Hudson
Caption: From Pier 45, just after the rain.
Any line without a key continues the caption.
Tags: NYC, Sunset, Water
Date: 2024-05-12 18:42
```

- **Tags** — comma separated. The album folder name is added automatically.
- **Date** — only needed to override the photo. `YYYY-MM-DD`, optionally
  followed by `HH:MM`.

## Dates

The date is read from the photo's metadata (EXIF "Date Taken"), so keep that
field when cleaning the other details. If it's missing, the page falls back to
a date in the file name (e.g. `IMG_20240512_184207.jpg`), and otherwise lists
the photo as *Undated* at the end.
