import type { MirrorAiConfig, MirrorConfig } from "@documirror/shared";
import { DEFAULT_AI_AUTH_TOKEN_ENV_VAR } from "@documirror/shared";

export function createDefaultConfig(
  siteUrl: string,
  targetLocale: string,
  ai: MirrorAiConfig,
): MirrorConfig {
  return {
    sourceUrl: siteUrl,
    targetLocale,
    entryUrls: [siteUrl],
    includePatterns: [],
    excludePatterns: [],
    crawlConcurrency: 4,
    requestTimeoutMs: 15_000,
    requestRetryCount: 2,
    requestRetryDelayMs: 500,
    requestHeaders: {
      "user-agent": "DocuMirror/0.1.0",
    },
    selectors: {
      include: [],
      exclude: [
        "script",
        "style",
        "noscript",
        "pre",
        "code",
        ".language-switcher",
      ],
    },
    attributeRules: {
      translate: ["title", "alt", "aria-label", "placeholder"],
      ignore: ["data-*"],
    },
    build: {
      basePath: "/",
      runtimeReconciler: {
        enabled: false,
        strategy: "dom-only",
        scope: "body-and-attributes",
      },
    },
    ai,
  };
}

export function createDefaultAiConfig(): MirrorAiConfig {
  return {
    providerKind: "openai-compatible",
    llmProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4.1-mini",
    authTokenEnvVar: DEFAULT_AI_AUTH_TOKEN_ENV_VAR,
    concurrency: 4,
    requestTimeoutMs: 300_000,
    maxAttemptsPerTask: 3,
    temperature: 0.2,
    chunking: {
      enabled: true,
      strategy: "structural",
      maxItemsPerChunk: 80,
      softMaxSourceCharsPerChunk: 6_000,
      hardMaxSourceCharsPerChunk: 9_000,
    },
  };
}
