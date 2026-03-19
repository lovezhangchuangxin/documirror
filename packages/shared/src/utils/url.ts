import { URL } from "node:url";

import { hashString } from "./hash";

export function urlToOutputPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = decodeURIComponent(url.pathname);
  const baseOutputPath = toPageOutputPath(pathname);
  return appendQuerySuffix(baseOutputPath, url.search);
}

export function urlToAssetOutputPath(rawUrl: string): string {
  const url = new URL(rawUrl);
  const pathname = decodeURIComponent(url.pathname);
  const baseOutputPath = toAssetOutputPath(pathname);
  return appendQuerySuffix(baseOutputPath, url.search);
}

function toPageOutputPath(pathname: string): string {
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

function toAssetOutputPath(pathname: string): string {
  if (!pathname || pathname === "/") {
    return "assets/index";
  }

  return pathname.replace(/^\/+/, "");
}

function appendQuerySuffix(outputPath: string, search: string): string {
  if (!search) {
    return outputPath;
  }

  // Keep query variants on distinct files so mirrored output paths do not collide.
  const suffix = `__q_${hashString(search).slice(0, 12)}`;
  const lastSlashIndex = outputPath.lastIndexOf("/");
  const directory =
    lastSlashIndex >= 0 ? outputPath.slice(0, lastSlashIndex + 1) : "";
  const fileName =
    lastSlashIndex >= 0 ? outputPath.slice(lastSlashIndex + 1) : outputPath;
  const extensionIndex = fileName.lastIndexOf(".");

  if (extensionIndex <= 0) {
    return `${directory}${fileName}${suffix}`;
  }

  return `${directory}${fileName.slice(0, extensionIndex)}${suffix}${fileName.slice(extensionIndex)}`;
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
