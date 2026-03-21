import { load } from "cheerio";
import { describe, expect, it } from "vitest";

import type {
  MirrorConfig,
  SegmentRecord,
  TranslationRecord,
} from "@documirror/shared";

import {
  collectRuntimeReconcilerManifestForPage,
  createRuntimeReconcilerAssetSource,
  createEmptyRuntimeReconcilerManifest,
  injectRuntimeReconcilerArtifacts,
  reconcileRuntimeSubtree,
} from "../runtime-reconciler";

function createConfig(): MirrorConfig {
  return {
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
      include: [],
      exclude: [],
    },
    attributeRules: {
      translate: ["title", "alt", "aria-label", "placeholder"],
      ignore: [],
    },
    build: {
      basePath: "/",
      runtimeReconciler: {
        enabled: true,
        strategy: "dom-only",
        scope: "body-and-attributes",
      },
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
}

function createSegment(overrides: Partial<SegmentRecord> = {}): SegmentRecord {
  return {
    segmentId: "segment-1",
    pageUrl: "https://docs.example.com/",
    domPath: "root[0]/main[0]/p[0]/#text[0]",
    kind: "text",
    sourceText: "Utilities",
    normalizedText: "Utilities",
    sourceHash: "segment-1-hash",
    context: {
      tagName: "p",
    },
    ...overrides,
  };
}

function createTranslation(
  overrides: Partial<TranslationRecord> = {},
): TranslationRecord {
  return {
    segmentId: "segment-1",
    targetLocale: "zh-CN",
    translatedText: "实用类",
    sourceHash: "segment-1-hash",
    status: "accepted",
    provider: "openai",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeTextNode {
  childNodes: FakeNode[] = [];
  nodeType = 3;
  parentNode: FakeElementNode | null = null;

  constructor(public textContent: string) {}
}

class FakeElementNode {
  childNodes: FakeNode[] = [];
  nodeType = 1;
  parentNode: FakeElementNode | null = null;
  private readonly attributes = new Map<string, string>();

  constructor(
    public tagName: string,
    attributes: Record<string, string> = {},
    children: FakeNode[] = [],
  ) {
    Object.entries(attributes).forEach(([name, value]) => {
      this.attributes.set(name, value);
    });
    children.forEach((child) => this.appendChild(child));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  appendChild(child: FakeNode): void {
    child.parentNode = this;
    this.childNodes.push(child);
  }
}

type FakeNode = FakeElementNode | FakeTextNode;

describe("runtime reconciler", () => {
  it("collects page-scoped text and attribute mappings while skipping conflicts", () => {
    const config = createConfig();
    const segments = [
      createSegment(),
      createSegment({
        segmentId: "segment-2",
        domPath: "root[0]/main[0]/img[0]",
        kind: "attr",
        attributeName: "alt",
        sourceText: "Hero image",
        normalizedText: "Hero image",
        sourceHash: "segment-2-hash",
        context: {
          tagName: "img",
        },
      }),
      createSegment({
        segmentId: "segment-3",
        domPath: "root[0]/main[0]/h2[0]/#text[0]",
        sourceText: "Install",
        normalizedText: "Install",
        sourceHash: "segment-3-hash",
        context: {
          tagName: "h2",
        },
      }),
      createSegment({
        segmentId: "segment-4",
        domPath: "root[0]/main[0]/button[0]/#text[0]",
        sourceText: "Install",
        normalizedText: "Install",
        sourceHash: "segment-4-hash",
        context: {
          tagName: "button",
        },
      }),
    ];
    const translationIndex = new Map(
      [
        createTranslation(),
        createTranslation({
          segmentId: "segment-2",
          sourceHash: "segment-2-hash",
          translatedText: "主视觉图片",
        }),
        createTranslation({
          segmentId: "segment-3",
          sourceHash: "segment-3-hash",
          translatedText: "安装",
        }),
        createTranslation({
          segmentId: "segment-4",
          sourceHash: "segment-4-hash",
          translatedText: "安装依赖",
        }),
      ].map((translation) => [translation.segmentId, translation]),
    );

    const result = collectRuntimeReconcilerManifestForPage({
      pageUrl: "https://docs.example.com/",
      config,
      segments,
      translationIndex,
    });

    expect(result.conflictCount).toBe(1);
    expect(result.manifest.text).toEqual({
      Utilities: "实用类",
    });
    expect(result.manifest.attributes.alt).toEqual({
      "Hero image": "主视觉图片",
    });
  });

  it("injects runtime data and loader without adding a bootstrap hook", () => {
    const $ = load(
      `<!doctype html><html><head><meta charset="utf-8"><script src="/app.js"></script></head><body><main><p>Utilities</p></main></body></html>`,
    );
    const manifest = createEmptyRuntimeReconcilerManifest();
    manifest.text.Utilities = "实用类";

    injectRuntimeReconcilerArtifacts(
      $,
      manifest,
      "/mirror/_documirror/runtime-reconciler.js",
    );

    const html = $.html();
    expect(html).toContain(`id="__DOCUMIRROR_RECONCILER_DATA__"`);
    expect(html).toContain(
      `src="/mirror/_documirror/runtime-reconciler.js" data-documirror-runtime-reconciler="true"`,
    );
    expect(html).not.toContain(`__next_f`);
  });

  it("builds a DOM-only runtime asset without any next payload hook", () => {
    const assetSource = createRuntimeReconcilerAssetSource();

    expect(assetSource).toContain(`MutationObserver`);
    expect(assetSource).not.toContain(`__next_f`);
    expect(assetSource).not.toContain(`self.__next_f`);
  });

  it("reconciles text nodes and whitelisted attributes while skipping code blocks", () => {
    const manifest = createEmptyRuntimeReconcilerManifest();
    manifest.text.Utilities = "实用类";
    manifest.attributes.alt["Hero image"] = "主视觉图片";

    const paragraphText = new FakeTextNode("Utilities");
    const paragraph = new FakeElementNode("p", {}, [paragraphText]);
    const image = new FakeElementNode("img", {
      alt: "Hero image",
      src: "/hero.png",
    });
    const codeText = new FakeTextNode("Utilities");
    const code = new FakeElementNode("code", {}, [codeText]);
    const root = new FakeElementNode("main", {}, [paragraph, image, code]);

    const result = reconcileRuntimeSubtree(root, manifest);

    expect(result).toEqual({
      attributeHits: 1,
      textHits: 1,
    });
    expect(paragraphText.textContent).toBe("实用类");
    expect(image.getAttribute("alt")).toBe("主视觉图片");
    expect(image.getAttribute("src")).toBe("/hero.png");
    expect(codeText.textContent).toBe("Utilities");
  });
});
