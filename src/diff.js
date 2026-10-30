import sharp from "sharp";
import pixelmatch from "pixelmatch";
import path from "node:path";
import { mkdir } from "node:fs/promises";

async function loadPaddedRaw(filePath, meta, width, height) {
  return sharp(filePath)
    .ensureAlpha()
    .extend({
      top: 0,
      left: 0,
      right: Math.max(0, width - meta.width),
      bottom: Math.max(0, height - meta.height),
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .raw()
    .toBuffer();
}

function findRegions(diffMask, width, height, blockSize, minDiffPixelsPerBlock, minRegionPixels) {
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const hot = new Uint8Array(cols * rows);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * blockSize, y0 = by * blockSize;
      const x1 = Math.min(width, x0 + blockSize), y1 = Math.min(height, y0 + blockSize);
      let count = 0;
      for (let y = y0; y < y1 && count < minDiffPixelsPerBlock; y++) {
        for (let x = x0; x < x1; x++) {
          if (diffMask[(y * width + x) * 4 + 3] > 0) {
            count++;
            if (count >= minDiffPixelsPerBlock) break;
          }
        }
      }
      if (count >= minDiffPixelsPerBlock) hot[by * cols + bx] = 1;
    }
  }

  const visited = new Uint8Array(cols * rows);
  const regions = [];
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const startIdx = by * cols + bx;
      if (!hot[startIdx] || visited[startIdx]) continue;

      const stack = [[bx, by]];
      visited[startIdx] = 1;
      let minBx = bx, maxBx = bx, minBy = by, maxBy = by;

      while (stack.length) {
        const [cx, cy] = stack.pop();
        minBx = Math.min(minBx, cx); maxBx = Math.max(maxBx, cx);
        minBy = Math.min(minBy, cy); maxBy = Math.max(maxBy, cy);
        for (const [dx, dy] of dirs) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (hot[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            stack.push([nx, ny]);
          }
        }
      }

      const x = minBx * blockSize;
      const y = minBy * blockSize;
      const w = Math.min(width, (maxBx + 1) * blockSize) - x;
      const h = Math.min(height, (maxBy + 1) * blockSize) - y;
      if (w * h >= minRegionPixels) regions.push({ x, y, w, h });
    }
  }

  return regions;
}

/**
 * Diffs one baseline/candidate screenshot pair, clusters changed pixels into
 * bounding-box regions, and crops before/after images for each region so a
 * VLM only has to look at the relevant area instead of the whole page.
 */
export async function diffPair(route, outDir, opts = {}) {
  const {
    threshold = 0.1,
    blockSize = 24,
    minDiffPixelsPerBlock = 3,
    minRegionPixels = 600,
    pad = 20,
  } = opts;

  const baseMeta = await sharp(route.baselinePath).metadata();
  const candMeta = await sharp(route.candidatePath).metadata();
  const width = Math.max(baseMeta.width, candMeta.width);
  const height = Math.max(baseMeta.height, candMeta.height);

  const baseRaw = await loadPaddedRaw(route.baselinePath, baseMeta, width, height);
  const candRaw = await loadPaddedRaw(route.candidatePath, candMeta, width, height);

  const diffMask = new Uint8Array(width * height * 4);
  const diffPixelCount = pixelmatch(baseRaw, candRaw, diffMask, width, height, {
    threshold,
    diffMask: true,
  });

  const regions = findRegions(diffMask, width, height, blockSize, minDiffPixelsPerBlock, minRegionPixels);

  const cropsDir = path.join(outDir, route.name);
  await mkdir(cropsDir, { recursive: true });

  const regionResults = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const cx = Math.max(0, r.x - pad);
    const cy = Math.max(0, r.y - pad);
    const cw = Math.min(width - cx, r.w + pad * 2);
    const ch = Math.min(height - cy, r.h + pad * 2);

    const beforeCropPath = path.join(cropsDir, `region-${i}.before.png`);
    const afterCropPath = path.join(cropsDir, `region-${i}.after.png`);

    await sharp(route.baselinePath)
      .ensureAlpha()
      .extend({ right: Math.max(0, width - baseMeta.width), bottom: Math.max(0, height - baseMeta.height), background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .extract({ left: cx, top: cy, width: cw, height: ch })
      .toFile(beforeCropPath);

    await sharp(route.candidatePath)
      .ensureAlpha()
      .extend({ right: Math.max(0, width - candMeta.width), bottom: Math.max(0, height - candMeta.height), background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .extract({ left: cx, top: cy, width: cw, height: ch })
      .toFile(afterCropPath);

    regionResults.push({ id: i, box: { x: cx, y: cy, w: cw, h: ch }, beforeCropPath, afterCropPath });
  }

  return {
    name: route.name,
    team: route.team,
    width,
    height,
    diffPixelCount,
    totalPixels: width * height,
    diffPercentage: (diffPixelCount / (width * height)) * 100,
    regions: regionResults,
  };
}

export async function diffAll(captured, outDir, opts) {
  const results = [];
  for (const route of captured) {
    results.push(await diffPair(route, outDir, opts));
  }
  return results;
}
