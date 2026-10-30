# Semantic Visual Regression Tester (SVRT)

Screenshots two builds of a web app (baseline vs. candidate), diffs them pixel-by-pixel,
crops just the changed regions, and asks a vision-language model (Claude) whether each
change looks **intentional** (copy/branding update) or a **likely bug** (overlapping
elements, truncated text, broken images, layout overflow). Outputs a single self-contained
HTML report and a machine-readable `results.json`, with a CI-friendly exit code.

Built to cut the false-positive noise of plain pixel-diff tools (Percy/Chromatic/etc.),
which flag *every* pixel change and train teams to click "approve" without looking.

## Pipeline

```
config/routes.json
      │
      ▼
[1] capture.js    Playwright screenshots every route for baselineBaseUrl and candidateBaseUrl
      │
      ▼
[2] diff.js       pixelmatch diffs each pair, clusters changed pixels into bounding-box
      │           regions (block + flood-fill), crops before/after around each region
      ▼
[3] classify.js   sends each before/after crop to Claude with a forced tool call;
      │           gets back { verdict, category, confidence, reasoning }
      ▼
[4] report.js     renders report.html (self-contained, base64-embedded crops) +
                   results.json; CLI exits 1 if any region is a high-confidence bug
```

## Running the demo

The repo ships with `fixtures/baseline` and `fixtures/candidate` — two versions of a
3-page toy app (dashboard, settings, billing). The candidate build has one uniform
rebrand (intentional) and two real UI bugs (overlapping toggle/label + truncated button
on settings; broken image + overflowing price on billing).

```bash
npm install
npx playwright install chromium   # first time only

# Live run (needs a real Anthropic Console API key, not a Claude Code session key)
export ANTHROPIC_API_KEY=sk-ant-...
node src/cli.js --config config/routes.demo.json --out reports/latest

# Or exercise the pipeline without any API key (labels regions from known
# fixture ground truth instead of calling the model — for demoing report rendering only)
node src/cli.js --config config/routes.demo.json --out reports/latest --mock-classify
```

Open `reports/latest/report.html` in a browser. `results.json` has the same data
structured for CI/dashboards.

## Pointing it at your real app

1. Write a `routes.json` (see `config/routes.demo.json`):
   - `baselineBaseUrl` / `candidateBaseUrl`: e.g. `https://staging-main.internal.app` vs
     `https://staging-pr-1234.internal.app`, or two local dev servers.
   - `routes`: path + `team` (used to group violations by owning team in the report).
2. If your app needs auth, extend `capture.js` to call
   `page.context().addCookies(...)` or run a login flow once before the loop — Playwright
   supports storing/reusing `storageState` across runs.
3. Tune `diff.js` options if needed: `threshold` (pixelmatch sensitivity), `blockSize` /
   `minDiffPixelsPerBlock` (how diffs get clustered into regions), `minRegionPixels`
   (noise floor — ignore tiny anti-aliasing diffs).
4. Tune the bug-confidence gate with `--threshold` (default `0.6`) — this is the knob for
   how aggressively CI blocks merges.

## CI integration

Run it as a job on PR builds once you have a deployed preview URL:

```bash
node src/cli.js --config config/routes.ci.json --out reports/$PR_NUMBER
# exit code is 1 if any region is classified "bug" with confidence >= threshold
```

Upload `reports/$PR_NUMBER/report.html` as a build artifact and link it from the PR check.
Start in "report only" mode (always exit 0, just surface the report) until you've tuned
the confidence threshold against a few weeks of real diffs, then flip on blocking.

## Notes / limitations

- `ANTHROPIC_API_KEY` must be a **Console API key** (console.anthropic.com), not a Claude
  Code CLI session credential — they are different kinds of keys.
- The region-clustering in `diff.js` is a simple block + flood-fill heuristic, not true
  connected-component labeling at pixel resolution — good enough to group a UI element's
  changed pixels into one crop, not meant to be pixel-perfect.
- Classification runs one Claude call per region (bounded concurrency via `--concurrency`).
  For a page with many simultaneous changes this means several calls per route — fine for
  CI, worth batching if you scale to hundreds of routes per run.
