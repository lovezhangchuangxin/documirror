import type { MirrorConfig } from "@documirror/shared";

export function createDefaultConfig(
  siteUrl: string,
  targetLocale: string,
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
    },
  };
}
