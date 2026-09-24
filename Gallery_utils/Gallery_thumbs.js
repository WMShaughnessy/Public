/**
 * Gallery — Gallery_thumbs.js
 *
 * Web worker that makes the small copies shown in the Thumbnails grid.
 * Gallery_script.js sends one photo at a time, so only one full-size photo
 * is ever decoded at once. A phone can't hold a grid of full-size photos in
 * memory: Safari reloads the page, then gives up with "A problem repeatedly
 * occurred". Decoding here, off the main thread, keeps the page responsive
 * while a large photo is shrunk.
 *
 * In:  { id, url, height }  — photo URL and the height of the copy in px
 * Out: { id, blob }         — a JPEG of that height
 *      { id, error }        — the photo couldn't be read or decoded
 */

self.onmessage = async e => {
  const { id, url, height } = e.data;
  let bitmap = null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Decoded straight to the small size; the full-size pixels are freed
    // once this returns.
    bitmap = await createImageBitmap(await res.blob(), { resizeHeight: height, resizeQuality: "high" });
    // A browser that ignores resizeHeight hands back the whole photo — scale it here.
    const h = Math.min(height, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * h / bitmap.height));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    self.postMessage({ id, blob });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  } finally {
    if (bitmap) bitmap.close();
  }
};
