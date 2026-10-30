#!/usr/bin/env node
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { captureAll } from "./capture.js";
import { diffAll } from "./diff.js";
import { classifyAll } from "./classify.js";
import { mockClassifyAll } from "./mockClassify.js";
import { writeReport } from "./report.js";

const program = new Command();

program
  .name("svrt")
  .description("Semantic visual regression tester: screenshots two builds, diffs them, and asks a VLM whether each change is intentional or a bug.")
  .requiredOption("-c, --config <path>", "path to a routes config JSON file")
  .option("-o, --out <dir>", "output directory", "reports/latest")
  .option("-t, --threshold <number>", "bug confidence threshold that fails the run (0-1)", "0.6")
  .option("--concurrency <number>", "parallel VLM classification calls", "3")
  .option("--mock-classify", "skip the live VLM call and label regions from known fixture ground truth (demo only)", false)
  .parse(process.argv);

const opts = program.opts();

async function main() {
  const cfg = JSON.parse(await readFile(opts.config, "utf8"));
  const outDir = path.resolve(opts.out);
  const threshold = Number(opts.threshold);
  const concurrency = Number(opts.concurrency);

  console.log(`[1/4] Capturing ${cfg.routes.length} route(s) for baseline + candidate...`);
  const captured = await captureAll(cfg, path.join(outDir, "screens"));

  console.log("[2/4] Diffing screenshots and extracting changed regions...");
  const diffResults = await diffAll(captured, path.join(outDir, "crops"));
  const totalRegions = diffResults.reduce((sum, r) => sum + r.regions.length, 0);
  console.log(`      found ${totalRegions} region(s) with visual changes above the noise threshold.`);

  let classifications;
  if (opts.mockClassify) {
    console.log(`[3/4] --mock-classify set: labeling ${totalRegions} region(s) from fixture ground truth (no model call)...`);
    classifications = await mockClassifyAll(diffResults);
  } else {
    console.log(`[3/4] Classifying ${totalRegions} region(s) with the vision model...`);
    classifications = await classifyAll(diffResults, { concurrency });
  }

  console.log("[4/4] Writing report...");
  const { reportPath, blockingBugs, counts } = await writeReport(diffResults, classifications, outDir, {
    bugConfidenceThreshold: threshold,
    mock: Boolean(opts.mockClassify),
  });

  console.log("");
  console.log(`Report: ${reportPath}`);
  console.log(`bugs=${counts.bug ?? 0} intentional=${counts.intentional ?? 0} uncertain=${counts.uncertain ?? 0}`);

  if (blockingBugs.length > 0) {
    console.log(`\nBLOCKED: ${blockingBugs.length} high-confidence bug(s):`);
    for (const b of blockingBugs) {
      console.log(`  - [${b.routeName}] ${b.category} (confidence ${(b.confidence * 100).toFixed(0)}%): ${b.reasoning}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\nCLEAR: no high-confidence bugs detected.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
