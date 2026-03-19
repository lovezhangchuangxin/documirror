import { createHash } from "node:crypto";
import { URL } from "node:url";

import { z } from "zod";

export const DOCUMIRROR_DIR = ".documirror";
export const DEFAULT_CRAWL_CONCURRENCY = 4;
export const DEFAULT_SEGMENTS_PER_TASK = 25;
export const JSONL_EOL = "\n";

export const selectorRulesSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export const buildConfigSchema = z.object({
  basePath: z.string().default("/"),
});

export const mirrorConfigSchema = z.object({
  sourceUrl: z.url(),
  targetLocale: z.string().min(2),
  entryUrls: z.array(z.url()).default([]),
  includePatterns: z.array(z.string()).default([]),
  excludePatterns: z.array(z.string()).default([]),
  crawlConcurrency: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(DEFAULT_CRAWL_CONCURRENCY),
  requestHeaders: z.record(z.string(), z.string()).default({}),
  selectors: selectorRulesSchema.default({
    include: [],
    exclude: [],
  }),
  attributeRules: z
    .object({
      translate: z
        .array(z.string())
        .default(["title", "alt", "aria-label", "placeholder"]),
      ignore: z.array(z.string()).default([]),
    })
    .default({
      translate: ["title", "alt", "aria-label", "placeholder"],
      ignore: [],
    }),
  build: buildConfigSchema.default({
    basePath: "/",
  }),
});

export type MirrorConfig = z.infer<typeof mirrorConfigSchema>;

export const assetRecordSchema = z.object({
  url: z.string(),
  cachePath: z.string(),
  outputPath: z.string(),
  contentType: z.string().optional(),
  contentHash: z.string(),
});

export type AssetRecord = z.infer<typeof assetRecordSchema>;

export const pageRecordSchema = z.object({
  url: z.string(),
  canonicalUrl: z.string(),
  status: z.number().int(),
  contentType: z.string(),
  snapshotPath: z.string(),
  outputPath: z.string(),
  pageHash: z.string(),
  discoveredFrom: z.string().nullable(),
  assetRefs: z.array(z.string()).default([]),
  extractedAt: z.string().optional(),
});

export type PageRecord = z.infer<typeof pageRecordSchema>;

export const manifestSchema = z.object({
  sourceUrl: z.string(),
  targetLocale: z.string(),
  generatedAt: z.string(),
  pages: z.record(z.string(), pageRecordSchema).default({}),
  assets: z.record(z.string(), assetRecordSchema).default({}),
});

export type Manifest = z.infer<typeof manifestSchema>;

export const segmentKindSchema = z.enum(["text", "attr", "meta"]);

export const segmentRecordSchema = z.object({
  segmentId: z.string(),
  pageUrl: z.string(),
  domPath: z.string(),
  kind: segmentKindSchema,
  attributeName: z.string().optional(),
  sourceText: z.string(),
  normalizedText: z.string(),
  sourceHash: z.string(),
  context: z.object({
    tagName: z.string(),
    pageTitle: z.string().optional(),
    surroundingText: z.string().optional(),
  }),
});

export type SegmentRecord = z.infer<typeof segmentRecordSchema>;

export const translationStatusSchema = z.enum(["draft", "accepted", "stale"]);

export const translationRecordSchema = z.object({
  segmentId: z.string(),
  targetLocale: z.string(),
  translatedText: z.string(),
  sourceHash: z.string(),
  status: translationStatusSchema,
  provider: z.string(),
  updatedAt: z.string(),
});

export type TranslationRecord = z.infer<typeof translationRecordSchema>;

export const assemblyBindingSchema = z.object({
  segmentId: z.string(),
  domPath: z.string(),
  kind: segmentKindSchema,
  attributeName: z.string().optional(),
});

export type AssemblyBinding = z.infer<typeof assemblyBindingSchema>;

export const assemblyMapSchema = z.object({
  pageUrl: z.string(),
  bindings: z.array(assemblyBindingSchema),
});

export type AssemblyMap = z.infer<typeof assemblyMapSchema>;

export const translationTaskItemSchema = z.object({
  segmentId: z.string(),
  sourceHash: z.string(),
  sourceText: z.string(),
  context: z.object({
    pageUrl: z.string(),
    domPath: z.string(),
    tagName: z.string(),
    pageTitle: z.string().optional(),
  }),
});

export type TranslationTaskItem = z.infer<typeof translationTaskItemSchema>;

export const translationTaskFileSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  sourceUrl: z.string(),
  targetLocale: z.string(),
  createdAt: z.string(),
  instructions: z.object({
    translateTo: z.string(),
    preserveFormatting: z.boolean(),
    preservePlaceholders: z.boolean(),
  }),
  glossary: z
    .array(z.object({ source: z.string(), target: z.string() }))
    .default([]),
  items: z.array(translationTaskItemSchema),
});

export type TranslationTaskFile = z.infer<typeof translationTaskFileSchema>;

export const translationResultItemSchema = z.object({
  segmentId: z.string(),
  sourceHash: z.string(),
  translatedText: z.string(),
});

export const translationResultFileSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  provider: z.string(),
  completedAt: z.string(),
  items: z.array(translationResultItemSchema),
});

export type TranslationResultFile = z.infer<typeof translationResultFileSchema>;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export const defaultLogger: Logger = {
  info(message) {
    console.log(message);
  },
  warn(message) {
    console.warn(message);
  },
  error(message) {
    console.error(message);
  },
};

export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createSegmentId(
  pageUrl: string,
  domPath: string,
  kind: string,
  attributeName?: string,
): string {
  return hashString([pageUrl, domPath, kind, attributeName ?? ""].join("::"));
}

export function createCacheFileName(url: string, extension: string): string {
  return `${hashString(url)}${extension}`;
}

export function urlToOutputPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname || pathname === "/") {
    return "index.html";
  }

  if (pathname.endsWith(".html")) {
    return pathname.replace(/^\/+/, "");
  }

  if (pathname.endsWith("/")) {
    return `${pathname.replace(/^\/+/, "")}index.html`;
  }

  const lastSegment = pathname.split("/").pop() ?? "";
  if (lastSegment.includes(".")) {
    return pathname.replace(/^\/+/, "");
  }

  return `${pathname.replace(/^\/+/, "")}/index.html`;
}

export function urlToAssetOutputPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname || pathname === "/") {
    return "assets/index";
  }

  return pathname.replace(/^\/+/, "");
}

export function isSameOrigin(sourceUrl: string, targetUrl: string): boolean {
  return new URL(sourceUrl).origin === new URL(targetUrl).origin;
}

export function normalizeUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  url.hash = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function matchesPatterns(value: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => new RegExp(pattern).test(value));
}

export function shouldIncludeUrl(
  value: string,
  includePatterns: string[],
  excludePatterns: string[],
): boolean {
  if (matchesPatterns(value, excludePatterns)) {
    return false;
  }

  if (includePatterns.length === 0) {
    return true;
  }

  return matchesPatterns(value, includePatterns);
}

export function createTimestamp(): string {
  return new Date().toISOString();
}
