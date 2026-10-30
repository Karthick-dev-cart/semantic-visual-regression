import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Screenshots every route for both baseline and candidate builds.
 * Returns a list of { name, team, baselinePath, candidatePath }.
 */
export async function captureAll(cfg, outDir) {
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch();
  const results = [];

  try {
    const page = await browser.newPage({ viewport: cfg.viewport });

    for (const route of cfg.routes) {
      const baselineUrl = cfg.baselineBaseUrl + route.path;
      const candidateUrl = cfg.candidateBaseUrl + route.path;

      const baselinePath = path.join(outDir, `${route.name}.baseline.png`);
      const candidatePath = path.join(outDir, `${route.name}.candidate.png`);

      await page.goto(baselineUrl, { waitUntil: "load" });
      await page.screenshot({ path: baselinePath, fullPage: true });

      await page.goto(candidateUrl, { waitUntil: "load" });
      await page.screenshot({ path: candidatePath, fullPage: true });

      results.push({
        name: route.name,
        team: route.team ?? "unknown",
        baselinePath,
        candidatePath,
      });
    }
  } finally {
    await browser.close();
  }

  return results;
}
