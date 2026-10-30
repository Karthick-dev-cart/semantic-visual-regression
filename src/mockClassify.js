/**
 * Stand-in for classify.js when no billable Anthropic API key is available.
 * Does NOT look at the images — it labels regions using the known ground
 * truth of the demo fixtures, purely so the report-rendering pipeline can
 * be exercised end-to-end. Every output is tagged as mock so it can never
 * be mistaken for real model inference.
 */
export async function mockClassifyAll(diffResults) {
  const results = [];
  for (const route of diffResults) {
    const isBugRoute = route.name !== "dashboard";
    for (const region of route.regions) {
      results.push({
        routeName: route.name,
        team: route.team,
        regionId: region.id,
        box: region.box,
        beforeCropPath: region.beforeCropPath,
        afterCropPath: region.afterCropPath,
        verdict: isBugRoute ? "bug" : "intentional",
        category: isBugRoute ? "layout/visual defect (mock label)" : "color/branding change (mock label)",
        confidence: isBugRoute ? 0.85 : 0.9,
        reasoning:
          "[MOCK DATA — not model inference] Labeled from known fixture ground truth to demonstrate report rendering only.",
      });
    }
  }
  return results;
}
