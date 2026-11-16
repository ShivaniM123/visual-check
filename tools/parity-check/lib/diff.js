/**
 * Pixel difference of the two screenshots: the PR's diff.js, in the browser. The screenshots are
 * decoded with a canvas instead of pngjs; the comparison (pixelmatch, same options), the hotspots
 * and the similarity are the same, and the decoded images are returned for the checks that look
 * at what is actually drawn (rules.js inkCoverage).
 */
import pixelmatch from './vendor/pixelmatch.js';

async function decode(src) {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function padTo(img, width, height) {
  if (img.width === width && img.height === height) return img;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const w = Math.min(img.width, width);
  for (let y = 0; y < Math.min(img.height, height); y += 1) {
    data.set(img.data.subarray(y * img.width * 4, (y * img.width + w) * 4), y * width * 4);
  }
  return { width, height, data };
}

/** Groups differing pixels into rectangular hotspots using a coarse grid (as in the PR). */
function hotspots(mask, width, height, cell = 24, minRatio = 0.12) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const hot = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      let n = 0;
      let total = 0;
      for (let y = r * cell; y < Math.min(height, (r + 1) * cell); y += 2) {
        for (let x = c * cell; x < Math.min(width, (c + 1) * cell); x += 2) {
          total += 1;
          if (mask[y * width + x]) n += 1;
        }
      }
      if (total && n / total >= minRatio) hot[r * cols + c] = 1;
    }
  }
  const seen = new Uint8Array(cols * rows);
  const regions = [];
  for (let i = 0; i < hot.length; i += 1) {
    if (hot[i] && !seen[i]) {
      const stack = [i];
      seen[i] = 1;
      let minC = cols; let maxC = 0; let minR = rows; let maxR = 0; let count = 0;
      while (stack.length) {
        const k = stack.pop();
        const r = Math.floor(k / cols);
        const c = k % cols;
        count += 1;
        minC = Math.min(minC, c); maxC = Math.max(maxC, c);
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        for (let dr = -2; dr <= 2; dr += 1) {
          for (let dc = -2; dc <= 2; dc += 1) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
              const j = nr * cols + nc;
              if (hot[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
            }
          }
        }
      }
      regions.push({
        x: minC * cell, y: minR * cell, w: (maxC - minC + 1) * cell, h: (maxR - minR + 1) * cell, cells: count,
      });
    }
  }
  return regions.sort((a, b) => b.cells - a.cells).slice(0, 40).sort((a, b) => a.y - b.y);
}

/**
 * Pixel diff of two screenshots (data URLs of the same page width, at 1 image pixel per CSS px).
 * Returns { similarity, changed, regions, shots: { o, m } } like the PR's diffScreenshots().
 */
export async function diffScreenshots(srcA, srcB, { threshold = 0.1 } = {}) {
  let [a, b] = await Promise.all([decode(srcA), decode(srcB)]);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  a = padTo(a, width, height);
  b = padTo(b, width, height);
  const out = new Uint8ClampedArray(width * height * 4);
  const changed = pixelmatch(a.data, b.data, out, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.15,
    diffColor: [230, 40, 90],
    diffColorAlt: [30, 120, 230],
  });
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if ((out[o] === 230 && out[o + 1] === 40 && out[o + 2] === 90) || (out[o] === 30 && out[o + 1] === 120 && out[o + 2] === 230)) mask[i] = 1;
  }
  return {
    width,
    height,
    changed,
    similarity: Math.round((1 - changed / (width * height)) * 1000) / 10,
    regions: hotspots(mask, width, height),
    shots: { o: a, m: b },
  };
}
