import { URL } from "node:url";

import { fileTypeFromBuffer } from "file-type";
import mime from "mime-types";
import PQueue from "p-queue";

import type { Logger, MirrorConfig } from "@documirror/shared";
import {
  isSameOrigin,
  normalizeUrl,
  shouldIncludeUrl,
  urlToAssetOutputPath,
  urlToOutputPath,
} from "@documirror/shared";

import { DEFAULT_USER_AGENT } from "./constants";
import { discoverPageResources } from "./link-discovery";
import { createAbortError, isAbortError, requestWithRetry } from "./request";
import { loadRobots } from "./robots";
import type {
  CrawledAsset,
  CrawledPage,
  CrawlIssue,
  CrawlProgress,
  CrawlResult,
  CrawlSink,
  CrawlStats,
} from "./types";

export async function crawlWebsite(
  config: MirrorConfig,
  _logger: Logger,
  sink: CrawlSink = {},
): Promise<CrawlResult> {
  const queue = new PQueue({ concurrency: config.crawlConcurrency });
  const signal = sink.signal;
  const visitedPages = new Set<string>();
  const scheduledAssets = new Set<string>();
  const issues: CrawlIssue[] = [];
  const fatalErrors: Error[] = [];
  const stats = createEmptyCrawlStats();
  const requestHeaders = {
    "user-agent": DEFAULT_USER_AGENT,
    ...config.requestHeaders,
  };
  let pageCount = 0;
  let assetCount = 0;
  let abortError: Error | undefined;

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw createAbortError(signal.reason);
    }
  };

  const reportProgress = (kind: CrawlProgress["kind"], url?: string) => {
    sink.onProgress?.({
      kind,
      pageCount,
      assetCount,
      url,
    });
  };

  const recordIssue = (issue: CrawlIssue) => {
    issues.push(issue);
    switch (issue.kind) {
      case "page-fetch":
        stats.pageFailures += 1;
        break;
      case "asset-fetch":
        stats.assetFailures += 1;
        break;
      case "invalid-link":
        stats.invalidLinks += 1;
        break;
      case "robots":
        stats.robotsFailures += 1;
        break;
    }
  };

  const trackRequest = (attemptCount: number, timeoutCount: number) => {
    stats.retriedRequests += Math.max(0, attemptCount - 1);
    stats.timedOutRequests += timeoutCount;
  };

  const enqueueTask = (task: () => Promise<void>) => {
    if (signal?.aborted) {
      abortError ??= createAbortError(signal.reason);
      return;
    }

    const scheduled = queue.add(task);
    scheduled.catch((error: unknown) => {
      if (isAbortError(error, signal)) {
        abortError ??= createAbortError(signal?.reason ?? error);
        queue.clear();
        return;
      }

      fatalErrors.push(normalizeError(error));
    });
  };

  const handleAbort = () => {
    abortError ??= createAbortError(signal?.reason);
    queue.clear();
  };

  signal?.addEventListener("abort", handleAbort, { once: true });

  try {
    throwIfAborted();
    reportProgress("start");
    const {
      robots,
      issue: robotsIssue,
      retryCount,
      timeoutCount,
    } = await loadRobots(config, signal);
    stats.retriedRequests += retryCount;
    stats.timedOutRequests += timeoutCount;
    if (robotsIssue) {
      recordIssue(robotsIssue);
    }

    const scheduleAsset = (
      candidateUrl: string,
      discoveredFrom: string | null,
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
      enqueueTask(async () => {
        throwIfAborted();
        let buffer = initialBuffer;
        let contentType = hintedContentType;

        if (!buffer) {
          const requestResult = await requestWithRetry<ArrayBuffer>({
            url: normalized,
            headers: requestHeaders,
            responseType: "arraybuffer",
            timeoutMs: config.requestTimeoutMs,
            retryCount: config.requestRetryCount,
            retryDelayMs: config.requestRetryDelayMs,
            signal,
          });
          trackRequest(requestResult.attemptCount, requestResult.timeoutCount);

          if (!requestResult.ok) {
            recordIssue({
              kind: "asset-fetch",
              severity: "warn",
              url: normalized,
              discoveredFrom,
              code: requestResult.code,
              attemptCount: requestResult.attemptCount,
              message: `Failed to fetch asset (${requestResult.errorMessage})`,
            });
            return;
          }

          if (requestResult.response.status >= 400) {
            recordIssue({
              kind: "asset-fetch",
              severity: "warn",
              url: normalized,
              discoveredFrom,
              statusCode: requestResult.response.status,
              attemptCount: requestResult.attemptCount,
              message: `Received ${requestResult.response.status} while fetching asset`,
            });
            return;
          }

          buffer = Buffer.from(requestResult.response.data);
          contentType = requestResult.response.headers["content-type"] as
            | string
            | undefined;
        }

        throwIfAborted();
        if (!buffer) {
          return;
        }

        if (!contentType) {
          contentType =
            (await fileTypeFromBuffer(buffer))?.mime ??
            (mime.lookup(new URL(normalized).pathname) ||
              "application/octet-stream");
        }

        const asset: CrawledAsset = {
          url: normalized,
          contentType,
          outputPath: urlToAssetOutputPath(normalized),
          buffer,
        };

        assetCount += 1;
        reportProgress("asset", normalized);
        throwIfAborted();
        await sink.onAsset?.(asset);
      });
    };

    const enqueuePage = (
      candidateUrl: string,
      discoveredFrom: string | null,
    ) => {
      const normalized = normalizeUrl(candidateUrl);
      if (visitedPages.has(normalized)) {
        return;
      }

      if (!isSameOrigin(config.sourceUrl, normalized)) {
        return;
      }

      // Entry URLs (discoveredFrom is null) are always crawled regardless of includePatterns.
      // Only discovered links are subject to pattern filtering.
      const isEntryUrl = discoveredFrom === null;
      if (
        !isEntryUrl &&
        !shouldIncludeUrl(
          normalized,
          config.includePatterns,
          config.excludePatterns,
        )
      ) {
        return;
      }

      visitedPages.add(normalized);
      enqueueTask(async () => {
        throwIfAborted();
        if (!robots.isAllowed(normalized, DEFAULT_USER_AGENT)) {
          stats.skippedByRobots += 1;
          return;
        }

        const requestResult = await requestWithRetry<ArrayBuffer>({
          url: normalized,
          headers: requestHeaders,
          responseType: "arraybuffer",
          timeoutMs: config.requestTimeoutMs,
          retryCount: config.requestRetryCount,
          retryDelayMs: config.requestRetryDelayMs,
          signal,
        });
        trackRequest(requestResult.attemptCount, requestResult.timeoutCount);

        if (!requestResult.ok) {
          recordIssue({
            kind: "page-fetch",
            severity: "warn",
            url: normalized,
            discoveredFrom,
            code: requestResult.code,
            attemptCount: requestResult.attemptCount,
            message: `Failed to fetch page (${requestResult.errorMessage})`,
          });
          return;
        }

        const contentType =
          requestResult.response.headers["content-type"] ?? "text/html";
        if (requestResult.response.status >= 400) {
          recordIssue({
            kind: "page-fetch",
            severity: "warn",
            url: normalized,
            discoveredFrom,
            statusCode: requestResult.response.status,
            attemptCount: requestResult.attemptCount,
            message: `Received ${requestResult.response.status} while fetching page`,
          });
          return;
        }

        throwIfAborted();
        if (!contentType.toLowerCase().includes("html")) {
          scheduleAsset(
            normalized,
            discoveredFrom,
            Buffer.from(requestResult.response.data),
            contentType || undefined,
          );
          return;
        }

        const html = Buffer.from(requestResult.response.data).toString("utf8");
        const discovered = discoverPageResources(normalized, html);

        discovered.invalidLinks.forEach((invalidLink) => {
          recordIssue({
            kind: "invalid-link",
            severity: "warn",
            url: normalized,
            discoveredFrom: null,
            message: `Ignoring invalid ${invalidLink.tagName}[${invalidLink.attributeName}] value "${invalidLink.rawValue}"`,
          });
        });

        throwIfAborted();
        discovered.assetUrls.forEach((assetUrl) =>
          scheduleAsset(assetUrl, normalized),
        );
        discovered.pageLinks.forEach((linkUrl) =>
          enqueuePage(linkUrl, normalized),
        );

        const page: CrawledPage = {
          url: normalized,
          canonicalUrl: normalized,
          status: requestResult.response.status,
          contentType: contentType || "text/html",
          outputPath: urlToOutputPath(normalized),
          discoveredFrom,
          assetRefs: discovered.assetUrls,
          html,
          crawledAt: new Date().toISOString(),
        };

        pageCount += 1;
        reportProgress("page", normalized);
        throwIfAborted();
        await sink.onPage?.(page);
      });
    };

    const entryUrls =
      config.entryUrls.length > 0 ? config.entryUrls : [config.sourceUrl];
    entryUrls.forEach((url) => enqueuePage(url, null));

    await queue.onIdle();
    if (abortError) {
      throw abortError;
    }
    if (fatalErrors.length > 0) {
      throw fatalErrors[0];
    }

    return {
      pageCount,
      assetCount,
      issues: sortIssues(issues),
      stats,
    };
  } finally {
    signal?.removeEventListener("abort", handleAbort);
  }
}

function createEmptyCrawlStats(): CrawlStats {
  return {
    pageFailures: 0,
    assetFailures: 0,
    invalidLinks: 0,
    skippedByRobots: 0,
    retriedRequests: 0,
    timedOutRequests: 0,
    robotsFailures: 0,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sortIssues(issues: CrawlIssue[]): CrawlIssue[] {
  return [...issues].sort((left, right) => {
    const severityOrder = compareSeverity(left.severity, right.severity);
    if (severityOrder !== 0) {
      return severityOrder;
    }

    return left.url.localeCompare(right.url);
  });
}

function compareSeverity(
  left: CrawlIssue["severity"],
  right: CrawlIssue["severity"],
): number {
  if (left === right) {
    return 0;
  }

  return left === "error" ? -1 : 1;
}
