import type { CrawlIssue } from "@documirror/crawler";
import type { CrawlSummary } from "@documirror/core";
import pc from "picocolors";

export type CommandOutput = {
  message: string;
  details: string[];
};

const MAX_ISSUE_SAMPLES = 5;

export function formatCrawlOutput(summary: CrawlSummary): CommandOutput {
  const details: string[] = [];

  if (
    summary.issueCount > 0 ||
    summary.stats.retriedRequests > 0 ||
    summary.stats.skippedByRobots > 0
  ) {
    details.push(pc.bold("Crawl Summary"));

    if (summary.stats.retriedRequests > 0) {
      details.push(`retried requests: ${summary.stats.retriedRequests}`);
    }

    if (summary.stats.skippedByRobots > 0) {
      details.push(`skipped by robots.txt: ${summary.stats.skippedByRobots}`);
    }

    if (summary.stats.pageFailures > 0) {
      details.push(`page failures: ${summary.stats.pageFailures}`);
    }

    if (summary.stats.assetFailures > 0) {
      details.push(`asset failures: ${summary.stats.assetFailures}`);
    }

    if (summary.stats.invalidLinks > 0) {
      details.push(`invalid links ignored: ${summary.stats.invalidLinks}`);
    }

    if (summary.stats.robotsFailures > 0) {
      details.push(`robots.txt fallbacks: ${summary.stats.robotsFailures}`);
    }

    if (summary.stats.timedOutRequests > 0) {
      details.push(`timed out requests: ${summary.stats.timedOutRequests}`);
    }

    if (summary.issueCount > 0) {
      details.push("sample issues:");
      summary.issues
        .slice(0, MAX_ISSUE_SAMPLES)
        .forEach((issue) => details.push(`- ${formatCrawlIssue(issue)}`));

      if (summary.issueCount > MAX_ISSUE_SAMPLES) {
        details.push(`- ...and ${summary.issueCount - MAX_ISSUE_SAMPLES} more`);
      }
    }
  }

  return {
    message: `Crawled ${summary.pageCount} pages and ${summary.assetCount} assets`,
    details,
  };
}

export function shouldFailCrawl(summary: CrawlSummary): boolean {
  return (
    summary.pageCount === 0 &&
    summary.assetCount === 0 &&
    (summary.stats.pageFailures > 0 || summary.stats.skippedByRobots > 0)
  );
}

export function formatFatalCrawlMessage(summary: CrawlSummary): string {
  const reasons: string[] = [];

  if (summary.stats.pageFailures > 0) {
    reasons.push(`${summary.stats.pageFailures} page failures`);
  }

  if (summary.stats.skippedByRobots > 0) {
    reasons.push(
      `${summary.stats.skippedByRobots} pages blocked by robots.txt`,
    );
  }

  if (summary.stats.robotsFailures > 0) {
    reasons.push(`${summary.stats.robotsFailures} robots.txt fallbacks`);
  }

  const firstIssue = summary.issues[0];
  if (firstIssue) {
    reasons.push(formatCrawlIssue(firstIssue));
  }

  return `Crawl produced no cached files${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`;
}

function formatCrawlIssue(issue: CrawlIssue): string {
  const contexts: string[] = [];

  if (issue.statusCode !== undefined) {
    contexts.push(`status ${issue.statusCode}`);
  }

  if (issue.code) {
    contexts.push(issue.code);
  }

  if (issue.attemptCount !== undefined && issue.attemptCount > 1) {
    contexts.push(`${issue.attemptCount} attempts`);
  }

  if (issue.discoveredFrom) {
    contexts.push(`from ${issue.discoveredFrom}`);
  }

  const suffix = contexts.length > 0 ? ` [${contexts.join(", ")}]` : "";
  return `${issue.url}: ${issue.message}${suffix}`;
}
