import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const VERDICT_STYLE = {
  bug: { label: "BUG", bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" },
  intentional: { label: "INTENTIONAL", bg: "#dcfce7", fg: "#166534", border: "#86efac" },
  uncertain: { label: "UNCERTAIN", bg: "#fef9c3", fg: "#854d0e", border: "#fde68a" },
};

async function toDataUri(filePath) {
  const buf = await readFile(filePath);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function renderRegion(c) {
  const style = VERDICT_STYLE[c.verdict] ?? VERDICT_STYLE.uncertain;
  const [before, after] = await Promise.all([toDataUri(c.beforeCropPath), toDataUri(c.afterCropPath)]);
  return `
  <div class="region" style="border-color:${style.border}">
    <div class="region-head">
      <span class="badge" style="background:${style.bg};color:${style.fg}">${style.label}</span>
      <span class="category">${escapeHtml(c.category)}</span>
      <span class="confidence">confidence ${(c.confidence * 100).toFixed(0)}%</span>
    </div>
    <div class="crops">
      <figure><img src="${before}" alt="before"><figcaption>before</figcaption></figure>
      <figure><img src="${after}" alt="after"><figcaption>after</figcaption></figure>
    </div>
    <p class="reasoning">${escapeHtml(c.reasoning)}</p>
  </div>`;
}

export async function renderReport(diffResults, classifications, opts = {}) {
  const { bugConfidenceThreshold = 0.6, mock = false } = opts;

  const byRoute = new Map(diffResults.map((r) => [r.name, r]));
  const grouped = new Map();
  for (const c of classifications) {
    if (!grouped.has(c.routeName)) grouped.set(c.routeName, []);
    grouped.get(c.routeName).push(c);
  }

  const blockingBugs = classifications.filter((c) => c.verdict === "bug" && c.confidence >= bugConfidenceThreshold);
  const counts = { bug: 0, intentional: 0, uncertain: 0 };
  for (const c of classifications) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;

  const sections = [];
  for (const [routeName, regions] of grouped) {
    const route = byRoute.get(routeName);
    const regionHtml = (await Promise.all(regions.map(renderRegion))).join("\n");
    sections.push(`
    <section class="route">
      <h2>${escapeHtml(routeName)} <span class="team">team: ${escapeHtml(route?.team ?? "unknown")}</span></h2>
      <p class="meta">${route ? `${route.diffPercentage.toFixed(2)}% of pixels changed · ${regions.length} region(s) flagged` : ""}</p>
      ${regionHtml || '<p class="meta">No regions above the noise threshold.</p>'}
    </section>`);
  }

  const noDiffRoutes = diffResults.filter((r) => !grouped.has(r.name));
  const noDiffHtml = noDiffRoutes
    .map((r) => `<section class="route"><h2>${escapeHtml(r.name)} <span class="team">team: ${escapeHtml(r.team)}</span></h2><p class="meta">No visual changes detected.</p></section>`)
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Semantic Visual Regression Report</title>
<style>
  body { font-family: -apple-system, Segoe UI, Arial, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 32px; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .summary { display: flex; gap: 12px; margin: 16px 0 28px; }
  .stat { flex: 1; background: #1e293b; border-radius: 8px; padding: 14px 18px; }
  .stat .n { font-size: 24px; font-weight: 700; }
  .stat .l { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: .04em; }
  .gate { padding: 14px 18px; border-radius: 8px; font-weight: 600; margin-bottom: 28px; }
  .gate.fail { background: #450a0a; color: #fca5a5; border: 1px solid #991b1b; }
  .gate.pass { background: #052e16; color: #86efac; border: 1px solid #166534; }
  .mock-banner { background: #3f2d00; color: #fde68a; border: 1px solid #a16207; padding: 10px 18px; border-radius: 8px; font-size: 13px; margin-bottom: 20px; }
  section.route { background: #1e293b; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
  section.route h2 { margin: 0 0 4px; font-size: 16px; }
  .team { font-size: 11px; color: #94a3b8; font-weight: 400; margin-left: 8px; }
  .meta { font-size: 12px; color: #94a3b8; margin: 0 0 12px; }
  .region { border: 1px solid; border-radius: 8px; padding: 14px; margin-bottom: 14px; background: #0f172a; }
  .region-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .badge { font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 4px; letter-spacing: .03em; }
  .category { font-size: 13px; color: #e2e8f0; }
  .confidence { font-size: 12px; color: #94a3b8; margin-left: auto; }
  .crops { display: flex; gap: 12px; margin-bottom: 10px; }
  .crops figure { margin: 0; flex: 1; text-align: center; }
  .crops img { max-width: 100%; border: 1px solid #334155; border-radius: 4px; }
  .crops figcaption { font-size: 11px; color: #64748b; margin-top: 4px; }
  .reasoning { font-size: 13px; color: #cbd5e1; margin: 0; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Semantic Visual Regression Report</h1>
    <p class="meta">Generated ${new Date().toISOString()}</p>
    ${mock ? '<div class="mock-banner">⚠ MOCK MODE — classifications below are hand-labeled from known fixture ground truth, not live model inference. Run without --mock-classify and a valid ANTHROPIC_API_KEY to see real results.</div>' : ""}
    <div class="summary">
      <div class="stat"><div class="n">${counts.bug ?? 0}</div><div class="l">Likely bugs</div></div>
      <div class="stat"><div class="n">${counts.intentional ?? 0}</div><div class="l">Intentional</div></div>
      <div class="stat"><div class="n">${counts.uncertain ?? 0}</div><div class="l">Uncertain</div></div>
    </div>
    <div class="gate ${blockingBugs.length ? "fail" : "pass"}">
      ${blockingBugs.length
        ? `BLOCKED — ${blockingBugs.length} high-confidence bug(s) detected (confidence ≥ ${(bugConfidenceThreshold * 100).toFixed(0)}%)`
        : `CLEAR — no high-confidence bugs detected (threshold ${(bugConfidenceThreshold * 100).toFixed(0)}%)`}
    </div>
    ${sections.join("\n")}
    ${noDiffHtml}
  </div>
</body>
</html>`;

  return { html, blockingBugs, counts };
}

export async function writeReport(diffResults, classifications, outDir, opts = {}) {
  const { html, blockingBugs, counts } = await renderReport(diffResults, classifications, opts);
  const reportPath = path.join(outDir, "report.html");
  const jsonPath = path.join(outDir, "results.json");
  await writeFile(reportPath, html, "utf8");
  await writeFile(jsonPath, JSON.stringify({ diffResults, classifications, counts }, null, 2), "utf8");
  return { reportPath, jsonPath, blockingBugs, counts };
}
