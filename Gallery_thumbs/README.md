# Gallery thumbnails

Small copies of the photos in `Gallery_images/`, shown by the Thumbnails
view on `Gallery.html`. Each is named after its photo's git blob SHA, so a
photo that changes gets a new copy.

**Don't edit this folder.** It's kept up to date by
`.github/workflows/gallery-thumbnails.yml`, which runs after every push to
`main` that touches `Gallery_images/` or this folder, adds copies of new
photos, deletes copies of removed ones, and commits the result. Until a copy is published
the page makes its own in the browser, so a new photo never shows a blank
tile.

To remake every copy (say, after changing the size in
`.github/scripts/gallery_thumbnails.py`), delete the `.jpg` files, push, and
the workflow rebuilds them. It can also be run by hand from the repo's
**Actions** tab.
