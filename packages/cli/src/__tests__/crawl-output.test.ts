import { describe, expect, it } from "vitest";

import type { CrawlSummary } from "@documirror/core";

import {
  formatCrawlOutput,
  formatFatalCrawlMessage,
  shouldFailCrawl,
} from "../crawl-output";

describe("crawl-output", () => {
  it("formats crawl summaries with issue samples", () => {
    const summary: CrawlSummary = {
      pageCount: 2,
      assetCount: 1,
      issueCount: 2,
      issues: [
        {
          kind: "robots",
          severity: "warn",
          url: "https://docs.example.com/robots.txt",
          message:
            "Received 503 for robots.txt; continuing with allow-all rules",
          discoveredFrom: null,
          statusCode: 503,
          attemptCount: 3,
        },
        {
          kind: "invalid-link",
          severity: "warn",
          url: "https://docs.example.com/",
          message: 'Ignoring invalid a[href] value "http://["',
          discoveredFrom: null,
        },
      ],
      stats: {
        pageFailures: 0,
        assetFailures: 0,
        invalidLinks: 1,
        skippedByRobots: 0,
        retriedRequests: 2,
        timedOutRequests: 1,
        robotsFailures: 1,
      },
    };

    const output = formatCrawlOutput(summary);

    expect(output.message).toBe("Crawled 2 pages and 1 assets");
    expect(output.details).toContain("retried requests: 2");
    expect(output.details).toContain("invalid links ignored: 1");
    expect(output.details.some((line) => line.includes("robots.txt"))).toBe(
      true,
    );
  });

  it("marks empty crawls with fatal fetch failures as failures", () => {
    const summary: CrawlSummary = {
      pageCount: 0,
      assetCount: 0,
      issueCount: 1,
      issues: [
        {
          kind: "page-fetch",
          severity: "warn",
          url: "https://docs.example.com/",
          message: "Failed to fetch page (Request timed out after 1000ms)",
          discoveredFrom: null,
          attemptCount: 2,
        },
      ],
      stats: {
        pageFailures: 1,
        assetFailures: 0,
        invalidLinks: 0,
        skippedByRobots: 0,
        retriedRequests: 1,
        timedOutRequests: 1,
        robotsFailures: 0,
      },
    };

    expect(shouldFailCrawl(summary)).toBe(true);
    expect(formatFatalCrawlMessage(summary)).toContain(
      "Crawl produced no cached files",
    );
    expect(formatFatalCrawlMessage(summary)).toContain("1 page failures");
  });

  it("does not fail an empty crawl when only robots fallback warnings exist", () => {
    const summary: CrawlSummary = {
      pageCount: 0,
      assetCount: 0,
      issueCount: 1,
      issues: [
        {
          kind: "robots",
          severity: "warn",
          url: "https://docs.example.com/robots.txt",
          message:
            "Received 503 for robots.txt; continuing with allow-all rules",
          discoveredFrom: null,
          statusCode: 503,
          attemptCount: 3,
        },
      ],
      stats: {
        pageFailures: 0,
        assetFailures: 0,
        invalidLinks: 0,
        skippedByRobots: 0,
        retriedRequests: 2,
        timedOutRequests: 0,
        robotsFailures: 1,
      },
    };

    expect(shouldFailCrawl(summary)).toBe(false);
  });
});
