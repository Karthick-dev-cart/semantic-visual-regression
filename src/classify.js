import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";

const client = new Anthropic();

const CLASSIFY_TOOL = {
  name: "report_classification",
  description: "Report the classification of a visual UI change between a before and after screenshot crop.",
  input_schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["intentional", "bug", "uncertain"] },
      category: {
        type: "string",
        description:
          "Short label, e.g. 'color/branding change', 'copy change', 'overlapping elements', 'truncated text', 'broken image', 'layout shift/overflow'",
      },
      confidence: { type: "number", description: "0 to 1" },
      reasoning: { type: "string", description: "One or two sentences explaining the verdict" },
    },
    required: ["verdict", "category", "confidence", "reasoning"],
  },
};

async function toImageBlock(filePath) {
  const data = await readFile(filePath);
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: data.toString("base64") },
  };
}

/** Classifies a single before/after crop as an intentional change, a bug, or uncertain. */
export async function classifyRegion({ routeName, team, beforeCropPath, afterCropPath }, opts = {}) {
  const { model = "claude-sonnet-5" } = opts;

  const [beforeImg, afterImg] = await Promise.all([
    toImageBlock(beforeCropPath),
    toImageBlock(afterCropPath),
  ]);

  const response = await client.messages.create({
    model,
    max_tokens: 500,
    system:
      "You are a visual regression reviewer for an enterprise SaaS product. You are shown a cropped 'before' and " +
      "'after' screenshot of the same region of a page, taken from two different builds. Decide whether the visual " +
      "change looks like an INTENTIONAL design update (copy change, rebrand/color update, consistent styling change) " +
      "or a likely BUG (overlapping elements, truncated/clipped text, broken images, misaligned layout, elements " +
      "escaping their container, text overflow). Use UNCERTAIN only if you genuinely cannot tell. Be decisive and " +
      "concrete about what you actually observe in the two images.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `Page: ${routeName} (owned by team: ${team}).\n\nBEFORE:` },
          beforeImg,
          { type: "text", text: "AFTER:" },
          afterImg,
          { type: "text", text: "Classify this change." },
        ],
      },
    ],
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: "report_classification" },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse) {
    return {
      verdict: "uncertain",
      category: "unknown",
      confidence: 0,
      reasoning: "Model did not return a classification.",
    };
  }
  return toolUse.input;
}

/** Classifies every region across every route, with bounded concurrency. */
export async function classifyAll(diffResults, opts = {}) {
  const { concurrency = 3 } = opts;

  const jobs = [];
  for (const route of diffResults) {
    for (const region of route.regions) {
      jobs.push({ route, region });
    }
  }

  const results = [];
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      const { route, region } = jobs[i];
      const classification = await classifyRegion({
        routeName: route.name,
        team: route.team,
        beforeCropPath: region.beforeCropPath,
        afterCropPath: region.afterCropPath,
      });
      results.push({
        routeName: route.name,
        team: route.team,
        regionId: region.id,
        box: region.box,
        beforeCropPath: region.beforeCropPath,
        afterCropPath: region.afterCropPath,
        ...classification,
      });
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker());
  await Promise.all(workers);

  results.sort((a, b) =>
    a.routeName === b.routeName ? a.regionId - b.regionId : a.routeName.localeCompare(b.routeName)
  );
  return results;
}
