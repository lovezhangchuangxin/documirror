import { z } from "zod";

import {
  DEFAULT_AI_AUTH_TOKEN_ENV_VAR,
  DEFAULT_AI_CHUNKING_ENABLED,
  DEFAULT_AI_CHUNKING_HARD_MAX_SOURCE_CHARS_PER_CHUNK,
  DEFAULT_AI_CHUNKING_MAX_ITEMS_PER_CHUNK,
  DEFAULT_AI_CHUNKING_SOFT_MAX_SOURCE_CHARS_PER_CHUNK,
  DEFAULT_AI_CONCURRENCY,
  DEFAULT_AI_MAX_ATTEMPTS_PER_TASK,
  DEFAULT_AI_REQUEST_TIMEOUT_MS,
  DEFAULT_AI_TEMPERATURE,
  DEFAULT_CRAWL_CONCURRENCY,
  DEFAULT_REQUEST_RETRY_COUNT,
  DEFAULT_REQUEST_RETRY_DELAY_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../constants";

export const selectorRulesSchema = z.object({
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
});

export const buildConfigSchema = z.object({
  basePath: z.string().default("/"),
});

export const mirrorAiChunkingConfigSchema = z.object({
  enabled: z.boolean().default(DEFAULT_AI_CHUNKING_ENABLED),
  strategy: z.literal("structural").default("structural"),
  maxItemsPerChunk: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(DEFAULT_AI_CHUNKING_MAX_ITEMS_PER_CHUNK),
  softMaxSourceCharsPerChunk: z
    .number()
    .int()
    .min(500)
    .max(100_000)
    .default(DEFAULT_AI_CHUNKING_SOFT_MAX_SOURCE_CHARS_PER_CHUNK),
  hardMaxSourceCharsPerChunk: z
    .number()
    .int()
    .min(500)
    .max(200_000)
    .default(DEFAULT_AI_CHUNKING_HARD_MAX_SOURCE_CHARS_PER_CHUNK),
});

export type MirrorAiChunkingConfig = z.infer<
  typeof mirrorAiChunkingConfigSchema
>;

export const mirrorAiConfigSchema = z.object({
  providerKind: z.literal("openai-compatible").default("openai-compatible"),
  llmProvider: z.string().trim().min(1).default("openai"),
  baseUrl: z.url(),
  modelName: z.string().trim().min(1),
  authTokenEnvVar: z
    .string()
    .trim()
    .min(1)
    .default(DEFAULT_AI_AUTH_TOKEN_ENV_VAR),
  concurrency: z.number().int().min(1).max(32).default(DEFAULT_AI_CONCURRENCY),
  requestTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(DEFAULT_AI_REQUEST_TIMEOUT_MS),
  maxAttemptsPerTask: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(DEFAULT_AI_MAX_ATTEMPTS_PER_TASK),
  temperature: z.number().min(0).max(2).default(DEFAULT_AI_TEMPERATURE),
  chunking: mirrorAiChunkingConfigSchema.default({
    enabled: DEFAULT_AI_CHUNKING_ENABLED,
    strategy: "structural",
    maxItemsPerChunk: DEFAULT_AI_CHUNKING_MAX_ITEMS_PER_CHUNK,
    softMaxSourceCharsPerChunk:
      DEFAULT_AI_CHUNKING_SOFT_MAX_SOURCE_CHARS_PER_CHUNK,
    hardMaxSourceCharsPerChunk:
      DEFAULT_AI_CHUNKING_HARD_MAX_SOURCE_CHARS_PER_CHUNK,
  }),
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
  requestTimeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  requestRetryCount: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(DEFAULT_REQUEST_RETRY_COUNT),
  requestRetryDelayMs: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(DEFAULT_REQUEST_RETRY_DELAY_MS),
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
  ai: mirrorAiConfigSchema.default({
    providerKind: "openai-compatible",
    llmProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4.1-mini",
    authTokenEnvVar: DEFAULT_AI_AUTH_TOKEN_ENV_VAR,
    concurrency: DEFAULT_AI_CONCURRENCY,
    requestTimeoutMs: DEFAULT_AI_REQUEST_TIMEOUT_MS,
    maxAttemptsPerTask: DEFAULT_AI_MAX_ATTEMPTS_PER_TASK,
    temperature: DEFAULT_AI_TEMPERATURE,
    chunking: {
      enabled: DEFAULT_AI_CHUNKING_ENABLED,
      strategy: "structural",
      maxItemsPerChunk: DEFAULT_AI_CHUNKING_MAX_ITEMS_PER_CHUNK,
      softMaxSourceCharsPerChunk:
        DEFAULT_AI_CHUNKING_SOFT_MAX_SOURCE_CHARS_PER_CHUNK,
      hardMaxSourceCharsPerChunk:
        DEFAULT_AI_CHUNKING_HARD_MAX_SOURCE_CHARS_PER_CHUNK,
    },
  }),
});

export type MirrorConfig = z.infer<typeof mirrorConfigSchema>;
export type MirrorAiConfig = z.infer<typeof mirrorAiConfigSchema>;
