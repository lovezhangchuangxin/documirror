import { describe, expect, it } from "vitest";

import type { MirrorConfig } from "@documirror/shared";

import { extractSegmentsFromHtml } from "./extract-segments";

describe("extractSegmentsFromHtml", () => {
  it("deduplicates overlapping include roots", () => {
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
    };

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
});
