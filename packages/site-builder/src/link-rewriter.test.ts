import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import { urlToAssetOutputPath, urlToOutputPath } from "@documirror/shared";
import type { Manifest, MirrorConfig } from "@documirror/shared";

import { rewriteLinks } from "./link-rewriter";

describe("rewriteLinks", () => {
  it("preserves fragments and rewrites srcset entries", () => {
    const guideUrl = "https://docs.example.com/guide?lang=en";
    const hero1Url = "https://docs.example.com/images/hero.png?v=1";
    const hero2Url = "https://docs.example.com/images/hero.png?v=2";
    const guideOutputPath = urlToOutputPath(guideUrl);
    const hero1OutputPath = urlToAssetOutputPath(hero1Url);
    const hero2OutputPath = urlToAssetOutputPath(hero2Url);
    const manifest: Manifest = {
      sourceUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      generatedAt: new Date().toISOString(),
      pages: {
        [guideUrl]: {
          url: guideUrl,
          canonicalUrl: guideUrl,
          status: 200,
          contentType: "text/html",
          snapshotPath: ".documirror/cache/pages/guide.html",
          outputPath: guideOutputPath,
          pageHash: "hash",
          discoveredFrom: null,
          assetRefs: [],
        },
      },
      assets: {
        [hero1Url]: {
          url: hero1Url,
          cachePath: `.documirror/cache/assets/${hero1OutputPath}`,
          outputPath: hero1OutputPath,
          contentHash: "hash-1",
          contentType: "image/png",
        },
        [hero2Url]: {
          url: hero2Url,
          cachePath: `.documirror/cache/assets/${hero2OutputPath}`,
          outputPath: hero2OutputPath,
          contentHash: "hash-2",
          contentType: "image/png",
        },
      },
    };
    const config: MirrorConfig = {
      sourceUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      entryUrls: ["https://docs.example.com"],
      includePatterns: [],
      excludePatterns: [],
      crawlConcurrency: 4,
      requestHeaders: {},
      selectors: {
        include: [],
        exclude: [],
      },
      attributeRules: {
        translate: ["title", "alt", "aria-label", "placeholder"],
        ignore: [],
      },
      build: {
        basePath: "/mirror",
      },
    };
    const $ = load(
      `<main><a href="/guide/?lang=en#install">Install</a><img srcset="/images/hero.png?v=1 1x, /images/hero.png?v=2 2x"></main>`,
    );

    rewriteLinks($, manifest, config, "https://docs.example.com/");

    expect($("a").attr("href")).toBe(`/mirror/${guideOutputPath}#install`);
    expect($("img").attr("srcset")).toBe(
      `/mirror/${hero1OutputPath} 1x, /mirror/${hero2OutputPath} 2x`,
    );
  });
});
