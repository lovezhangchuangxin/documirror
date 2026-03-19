import { URL } from "node:url";

import axios from "axios";
import { fileTypeFromBuffer } from "file-type";
import mime from "mime-types";
import PQueue from "p-queue";

import type { Logger, MirrorConfig } from "@documirror/shared";
import {
  createTimestamp,
  isSameOrigin,
  normalizeUrl,
  shouldIncludeUrl,
  urlToAssetOutputPath,
  urlToOutputPath,
} from "@documirror/shared";

import { DEFAULT_USER_AGENT } from "./constants";
import { discoverAssets, discoverPageLinks } from "./link-discovery";
import { loadRobots } from "./robots";
import type { CrawledAsset, CrawledPage, CrawlResult } from "./types";

export async function crawlWebsite(
  config: MirrorConfig,
  logger: Logger,
): Promise<CrawlResult> {
  const pageQueue = new PQueue({ concurrency: config.crawlConcurrency });
  const assetQueue = new PQueue({
    concurrency: Math.max(1, config.crawlConcurrency),
  });
  const visitedPages = new Set<string>();
  const scheduledAssets = new Set<string>();
  const pages: CrawledPage[] = [];
  const assets: CrawledAsset[] = [];
  const robots = await loadRobots(config);

  const scheduleAsset = (
    candidateUrl: string,
    initialBuffer?: Buffer,
    hintedContentType?: string,
  ) => {
    const normalized = normalizeUrl(candidateUrl);
    if (
      scheduledAssets.has(normalized) ||
      !isSameOrigin(config.sourceUrl, normalized)
    ) {
      return;
    }

    scheduledAssets.add(normalized);
    assetQueue.add(async () => {
      let buffer = initialBuffer;
      let contentType = hintedContentType;

      if (!buffer) {
        const response = await axios.get<ArrayBuffer>(normalized, {
          headers: {
            "user-agent": DEFAULT_USER_AGENT,
            ...config.requestHeaders,
          },
          responseType: "arraybuffer",
          validateStatus: () => true,
        });

        if (response.status >= 400) {
          logger.warn(`Asset fetch failed ${response.status}: ${normalized}`);
          return;
        }

        buffer = Buffer.from(response.data);
        contentType = response.headers["content-type"] as string | undefined;
      }

      if (!buffer) {
        return;
      }

      if (!contentType) {
        contentType =
          (await fileTypeFromBuffer(buffer))?.mime ??
          (mime.lookup(new URL(normalized).pathname) ||
            "application/octet-stream");
      }

      assets.push({
        url: normalized,
        contentType,
        outputPath: urlToAssetOutputPath(normalized),
        buffer,
      });
    });
  };

  const enqueuePage = (candidateUrl: string, discoveredFrom: string | null) => {
    const normalized = normalizeUrl(candidateUrl);
    if (visitedPages.has(normalized)) {
      return;
    }

    if (!isSameOrigin(config.sourceUrl, normalized)) {
      return;
    }

    if (
      !shouldIncludeUrl(
        normalized,
        config.includePatterns,
        config.excludePatterns,
      )
    ) {
      return;
    }

    visitedPages.add(normalized);
    pageQueue.add(async () => {
      if (!robots.isAllowed(normalized, DEFAULT_USER_AGENT)) {
        logger.warn(`Skipping disallowed by robots.txt: ${normalized}`);
        return;
      }

      const response = await axios.get<ArrayBuffer>(normalized, {
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          ...config.requestHeaders,
        },
        responseType: "arraybuffer",
        validateStatus: () => true,
      });

      const contentType = response.headers["content-type"] ?? "text/html";
      if (response.status >= 400) {
        logger.warn(`Received ${response.status} for ${normalized}`);
        return;
      }

      if (!contentType.includes("html")) {
        scheduleAsset(normalized, Buffer.from(response.data), contentType);
        return;
      }

      const html = Buffer.from(response.data).toString("utf8");
      const discoveredAssets = discoverAssets(normalized, html);
      const discoveredLinks = discoverPageLinks(normalized, html);

      discoveredAssets.forEach((assetUrl) => scheduleAsset(assetUrl));
      discoveredLinks.forEach((linkUrl) => enqueuePage(linkUrl, normalized));

      pages.push({
        url: normalized,
        canonicalUrl: normalized,
        status: response.status,
        contentType,
        outputPath: urlToOutputPath(normalized),
        discoveredFrom,
        assetRefs: discoveredAssets,
        html,
        crawledAt: createTimestamp(),
      });
      logger.info(`Crawled ${normalized}`);
    });
  };

  const entryUrls =
    config.entryUrls.length > 0 ? config.entryUrls : [config.sourceUrl];
  entryUrls.forEach((url) => enqueuePage(url, null));

  await pageQueue.onIdle();
  await assetQueue.onIdle();

  pages.sort((left, right) => left.url.localeCompare(right.url));
  assets.sort((left, right) => left.url.localeCompare(right.url));

  return {
    pages,
    assets,
  };
}
