import { URL } from "node:url";

import axios from "axios";
import { load } from "cheerio";
import { fileTypeFromBuffer } from "file-type";
import mime from "mime-types";
import PQueue from "p-queue";
import robotsParserModule from "robots-parser";

import type { Logger, MirrorConfig } from "@documirror/shared";
import {
  createTimestamp,
  isSameOrigin,
  normalizeUrl,
  shouldIncludeUrl,
  urlToAssetOutputPath,
  urlToOutputPath,
} from "@documirror/shared";

export type CrawledPage = {
  url: string;
  canonicalUrl: string;
  status: number;
  contentType: string;
  outputPath: string;
  discoveredFrom: string | null;
  assetRefs: string[];
  html: string;
  crawledAt: string;
};

export type CrawledAsset = {
  url: string;
  contentType: string;
  outputPath: string;
  buffer: Buffer;
};

export type CrawlResult = {
  pages: CrawledPage[];
  assets: CrawledAsset[];
};

type RobotsLike = {
  isAllowed: (url: string, userAgent: string) => boolean;
};

const DEFAULT_USER_AGENT = "DocuMirror/0.1.0";
const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsLike;

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

function discoverPageLinks(baseUrl: string, html: string): string[] {
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

function discoverAssets(baseUrl: string, html: string): string[] {
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

function resolveLink(
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

async function loadRobots(config: MirrorConfig): Promise<RobotsLike> {
  try {
    const source = new URL(config.sourceUrl);
    const robotsUrl = `${source.origin}/robots.txt`;
    const response = await axios.get<string>(robotsUrl, {
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        ...config.requestHeaders,
      },
      responseType: "text",
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      return allowAllRobots();
    }

    return robotsParser(robotsUrl, response.data);
  } catch {
    return allowAllRobots();
  }
}

function allowAllRobots(): RobotsLike {
  return {
    isAllowed: () => true,
  };
}
