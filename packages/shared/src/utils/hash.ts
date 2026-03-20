import { createHash } from "node:crypto";

export function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashBuffer(value: Uint8Array): string {
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

export function createSegmentReuseKey(options: {
  pageUrl: string;
  kind: string;
  normalizedText: string;
  tagName: string;
  attributeName?: string;
  pageTitle?: string;
}): string {
  const { pageUrl, kind, normalizedText, tagName, attributeName, pageTitle } =
    options;
  return hashString(
    [
      pageUrl,
      kind,
      attributeName ?? "",
      tagName,
      pageTitle ?? "",
      normalizedText,
    ].join("::"),
  );
}

export function createCacheFileName(url: string, extension: string): string {
  return `${hashString(url)}${extension}`;
}
