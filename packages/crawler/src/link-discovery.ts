import { URL } from "node:url";

import { load } from "cheerio";

import { normalizeUrl } from "@documirror/shared";

export function discoverPageLinks(baseUrl: string, html: string): string[] {
  const $ = load(html);
  const links = new Set<string>();

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    const resolved = resolveLink(baseUrl, href);
    if (resolved) {
      links.add(resolved);
    }
  });

  return [...links];
}

export function discoverAssets(baseUrl: string, html: string): string[] {
  const $ = load(html);
  const assets = new Set<string>();

  const collect = (value: string | undefined) => {
    const resolved = resolveLink(baseUrl, value);
    if (resolved) {
      assets.add(resolved);
    }
  };

  $("img[src], script[src], source[src], video[src], audio[src]").each(
    (_, element) => {
      collect($(element).attr("src"));
    },
  );

  $("link[href]").each((_, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase();
    if (
      ["stylesheet", "icon", "preload", "modulepreload", "mask-icon"].some(
        (value) => rel.includes(value),
      )
    ) {
      collect($(element).attr("href"));
    }
  });

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    srcset
      ?.split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .forEach(collect);
  });

  return [...assets];
}

export function resolveLink(
  baseUrl: string,
  rawHref: string | undefined,
): string | null {
  if (!rawHref) {
    return null;
  }

  const trimmed = rawHref.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("javascript:")
  ) {
    return null;
  }

  const resolved = new URL(trimmed, baseUrl);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  return normalizeUrl(resolved.toString());
}
