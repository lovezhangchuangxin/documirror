import { createHash } from "node:crypto";

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
