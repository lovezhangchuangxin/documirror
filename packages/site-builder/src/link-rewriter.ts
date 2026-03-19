import { URL } from "node:url";

import type { CheerioAPI } from "cheerio";

import { normalizeUrl } from "@documirror/shared";
import type { Manifest, MirrorConfig } from "@documirror/shared";

export function rewriteLinks(
  $: CheerioAPI,
  manifest: Manifest,
  config: MirrorConfig,
  pageUrl: string,
): void {
  const pageMap = new Map(
    Object.values(manifest.pages).map((page) => [
      page.url,
      toPublicPath(page.outputPath, config.build.basePath),
    ]),
  );
  const assetMap = new Map(
    Object.values(manifest.assets).map((asset) => [
      asset.url,
      toPublicPath(asset.outputPath, config.build.basePath),
    ]),
  );

  $("[href], [src]").each((_, element) => {
    const href = $(element).attr("href");
    const src = $(element).attr("src");

    if (href) {
      const rewritten = rewriteUrl(href, pageUrl, pageMap, assetMap);
      if (rewritten) {
        $(element).attr("href", rewritten);
      }
    }

    if (src) {
      const rewritten = rewriteUrl(src, pageUrl, pageMap, assetMap);
      if (rewritten) {
        $(element).attr("src", rewritten);
      }
    }
  });

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    if (!srcset) {
      return;
    }

    const rewritten = rewriteSrcset(srcset, pageUrl, pageMap, assetMap);
    if (rewritten !== srcset) {
      $(element).attr("srcset", rewritten);
    }
  });
}

function rewriteUrl(
  rawValue: string,
  sourceUrl: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, string>,
): string | null {
  if (
    rawValue.startsWith("#") ||
    rawValue.startsWith("mailto:") ||
    rawValue.startsWith("tel:") ||
    rawValue.startsWith("javascript:")
  ) {
    return null;
  }

  const resolved = new URL(rawValue, sourceUrl);
  const normalized = normalizeUrl(resolved.toString());
  const rewritten = pageMap.get(normalized) ?? assetMap.get(normalized) ?? null;
  if (!rewritten) {
    return null;
  }

  return `${rewritten}${resolved.hash}`;
}

function rewriteSrcset(
  rawValue: string,
  sourceUrl: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, string>,
): string {
  return rawValue
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .map((candidate) => {
      const [url, ...descriptorParts] = candidate.split(/\s+/);
      const rewrittenUrl = rewriteUrl(url, sourceUrl, pageMap, assetMap);
      const descriptor = descriptorParts.join(" ");

      if (!rewrittenUrl) {
        return candidate;
      }

      return descriptor ? `${rewrittenUrl} ${descriptor}` : rewrittenUrl;
    })
    .join(", ");
}

function toPublicPath(outputPath: string, basePath: string): string {
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (outputPath === "index.html") {
    return `${prefix || ""}/`;
  }

  if (outputPath.endsWith("/index.html")) {
    return `${prefix}/${outputPath.slice(0, -"index.html".length)}`;
  }

  return `${prefix}/${outputPath}`;
}
