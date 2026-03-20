import { describe, expect, it } from "vitest";

import type { MirrorConfig } from "@documirror/shared";

import { extractSegmentsFromHtml } from "../extract-segments";
import { buildTranslationTaskUnits } from "../task-units";

describe("extractSegmentsFromHtml", () => {
  const config: MirrorConfig = {
    sourceUrl: "https://docs.example.com",
    targetLocale: "zh-CN",
    entryUrls: ["https://docs.example.com"],
    includePatterns: [],
    excludePatterns: [],
    crawlConcurrency: 4,
    requestTimeoutMs: 15_000,
    requestRetryCount: 2,
    requestRetryDelayMs: 500,
    requestHeaders: {},
    selectors: {
      include: ["main article", "main"],
      exclude: [],
    },
    attributeRules: {
      translate: ["title", "alt", "aria-label", "placeholder"],
      ignore: [],
    },
    build: {
      basePath: "/",
    },
    ai: {
      providerKind: "openai-compatible",
      llmProvider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
      authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
      concurrency: 4,
      requestTimeoutMs: 60_000,
      maxAttemptsPerTask: 3,
      temperature: 0.2,
      chunking: {
        enabled: true,
        strategy: "structural",
        maxItemsPerChunk: 80,
        softMaxSourceCharsPerChunk: 6_000,
        hardMaxSourceCharsPerChunk: 9_000,
      },
    },
  };

  it("deduplicates overlapping include roots", () => {
    const extracted = extractSegmentsFromHtml(
      `<!doctype html><html><head><title>Docs</title></head><body><main><article><h1>Hello world</h1></article></main></body></html>`,
      "https://docs.example.com/",
      config,
    );
    const helloSegment = extracted.segments.find(
      (segment) => segment.normalizedText === "Hello world",
    );

    expect(helloSegment).toBeDefined();
    expect(
      extracted.assemblyMap.bindings.filter(
        (binding) => binding.segmentId === helloSegment?.segmentId,
      ),
    ).toHaveLength(1);
  });

  it("groups text segments separated by inline code into one task unit", () => {
    const pageUrl = "https://docs.example.com/";
    const html = `<!doctype html><html><head><title>Docs</title></head><body><main><article><p>Use the <code>snap-always</code> utility together</p></article></main></body></html>`;
    const extracted = extractSegmentsFromHtml(html, pageUrl, config);

    const units = buildTranslationTaskUnits(
      html,
      pageUrl,
      config,
      extracted.segments,
    );

    expect(units).toEqual([
      {
        segments: [
          expect.objectContaining({
            sourceText: "Use the ",
          }),
          expect.objectContaining({
            sourceText: " utility together",
          }),
        ],
        text: "Use the `snap-always` utility together",
        note: "Treat text wrapped in backticks as code literals, keep them unchanged in the same order, and do not move surrounding text across code boundaries.",
        inlineCodeSpans: [
          {
            text: "snap-always",
          },
        ],
        textSlotIndices: [0, 1],
      },
    ]);
  });

  it("groups text with leading and trailing inline code", () => {
    const pageUrl = "https://docs.example.com/";
    const html = `<!doctype html><html><head><title>Docs</title></head><body><main><article><p><code>snap-always</code> is enabled</p><p>Run <code>npm install</code></p></article></main></body></html>`;
    const extracted = extractSegmentsFromHtml(html, pageUrl, config);

    const units = buildTranslationTaskUnits(
      html,
      pageUrl,
      config,
      extracted.segments,
    );

    expect(units).toEqual([
      {
        segments: [
          expect.objectContaining({
            sourceText: " is enabled",
          }),
        ],
        text: "`snap-always` is enabled",
        note: "Treat text wrapped in backticks as code literals, keep them unchanged in the same order, and do not move surrounding text across code boundaries.",
        inlineCodeSpans: [
          {
            text: "snap-always",
          },
        ],
        textSlotIndices: [1],
      },
      {
        segments: [
          expect.objectContaining({
            sourceText: "Run ",
          }),
        ],
        text: "Run `npm install`",
        note: "Treat text wrapped in backticks as code literals, keep them unchanged in the same order, and do not move surrounding text across code boundaries.",
        inlineCodeSpans: [
          {
            text: "npm install",
          },
        ],
        textSlotIndices: [0],
      },
    ]);
  });
});
