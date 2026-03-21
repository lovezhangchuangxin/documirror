import { URL } from "node:url";

import { load } from "cheerio";

import { extractCssUrlReferences, normalizeUrl } from "@documirror/shared";

import type { InvalidLinkReference, LinkDiscoveryResult } from "./types";

export function discoverPageResources(
  baseUrl: string,
  html: string,
): LinkDiscoveryResult {
  const $ = load(html);
  const pageLinks = new Set<string>();
  const assetUrls = new Set<string>();
  const invalidLinks: InvalidLinkReference[] = [];
  const seenInvalidLinks = new Set<string>();

  const collect = (
    collection: Set<string>,
    rawValue: string | undefined,
    tagName: string,
    attributeName: string,
  ) => {
    const resolved = resolveLink(baseUrl, rawValue, tagName, attributeName);
    if (resolved.url) {
      collection.add(resolved.url);
      return;
    }

    if (resolved.issue) {
      const issueKey = [
        resolved.issue.tagName,
        resolved.issue.attributeName,
        resolved.issue.rawValue,
      ].join("::");
      if (!seenInvalidLinks.has(issueKey)) {
        seenInvalidLinks.add(issueKey);
        invalidLinks.push(resolved.issue);
      }
    }
  };

  $("a[href]").each((_, element) => {
    collect(pageLinks, $(element).attr("href"), element.tagName, "href");
  });

  $("img[src], script[src], source[src], video[src], audio[src]").each(
    (_, element) => {
      collect(assetUrls, $(element).attr("src"), element.tagName, "src");
    },
  );

  $("link[href]").each((_, element) => {
    const rel = ($(element).attr("rel") ?? "").toLowerCase();
    if (
      ["stylesheet", "icon", "preload", "modulepreload", "mask-icon"].some(
        (value) => rel.includes(value),
      )
    ) {
      collect(assetUrls, $(element).attr("href"), element.tagName, "href");
    }
  });

  $("[srcset]").each((_, element) => {
    const srcset = $(element).attr("srcset");
    srcset
      ?.split(",")
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .forEach((candidate) => {
        collect(assetUrls, candidate, element.tagName, "srcset");
      });
  });

  $("[style]").each((_, element) => {
    const style = $(element).attr("style");
    if (!style) {
      return;
    }

    extractCssUrlReferences(style).forEach(({ value }) => {
      collect(assetUrls, value, element.tagName, "style");
    });
  });

  return {
    pageLinks: [...pageLinks],
    assetUrls: [...assetUrls],
    invalidLinks,
  };
}

export function resolveLink(
  baseUrl: string,
  rawHref: string | undefined,
  tagName: string,
  attributeName: string,
): {
  url: string | null;
  issue?: InvalidLinkReference;
} {
  if (!rawHref) {
    return {
      url: null,
    };
  }

  const trimmed = rawHref.trim();
  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("mailto:") ||
    trimmed.startsWith("javascript:")
  ) {
    return {
      url: null,
    };
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return {
        url: null,
      };
    }

    return {
      url: normalizeUrl(resolved.toString()),
    };
  } catch {
    return {
      url: null,
      issue: {
        rawValue: trimmed,
        tagName,
        attributeName,
      },
    };
  }
}
