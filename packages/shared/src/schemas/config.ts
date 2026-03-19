import { z } from "zod";

import { DEFAULT_CRAWL_CONCURRENCY } from "../constants";

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
