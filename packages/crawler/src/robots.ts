import { URL } from "node:url";

import robotsParserModule from "robots-parser";

import type { MirrorConfig } from "@documirror/shared";

import { DEFAULT_USER_AGENT } from "./constants";
import { requestWithRetry } from "./request";
import type { CrawlIssue, RobotsLike } from "./types";

const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsLike;

type LoadRobotsResult = {
  robots: RobotsLike;
  issue?: CrawlIssue;
  retryCount: number;
  timeoutCount: number;
};

export async function loadRobots(
  config: MirrorConfig,
): Promise<LoadRobotsResult> {
  const source = new URL(config.sourceUrl);
  const robotsUrl = `${source.origin}/robots.txt`;
  const requestResult = await requestWithRetry<string>({
    url: robotsUrl,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      ...config.requestHeaders,
    },
    responseType: "text",
    timeoutMs: config.requestTimeoutMs,
    retryCount: config.requestRetryCount,
    retryDelayMs: config.requestRetryDelayMs,
  });

  if (!requestResult.ok) {
    return {
      robots: allowAllRobots(),
      retryCount: requestResult.attemptCount - 1,
      timeoutCount: requestResult.timeoutCount,
      issue: {
        kind: "robots",
        severity: "warn",
        url: robotsUrl,
        discoveredFrom: null,
        code: requestResult.code,
        attemptCount: requestResult.attemptCount,
        message: `Failed to load robots.txt (${requestResult.errorMessage}); continuing with allow-all rules`,
      },
    };
  }

  if (requestResult.response.status === 404) {
    return {
      robots: allowAllRobots(),
      retryCount: requestResult.attemptCount - 1,
      timeoutCount: requestResult.timeoutCount,
    };
  }

  if (requestResult.response.status >= 400) {
    return {
      robots: allowAllRobots(),
      retryCount: requestResult.attemptCount - 1,
      timeoutCount: requestResult.timeoutCount,
      issue: {
        kind: "robots",
        severity: "warn",
        url: robotsUrl,
        discoveredFrom: null,
        statusCode: requestResult.response.status,
        attemptCount: requestResult.attemptCount,
        message: `Received ${requestResult.response.status} for robots.txt; continuing with allow-all rules`,
      },
    };
  }

  try {
    return {
      robots: robotsParser(robotsUrl, requestResult.response.data),
      retryCount: requestResult.attemptCount - 1,
      timeoutCount: requestResult.timeoutCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      robots: allowAllRobots(),
      retryCount: requestResult.attemptCount - 1,
      timeoutCount: requestResult.timeoutCount,
      issue: {
        kind: "robots",
        severity: "warn",
        url: robotsUrl,
        discoveredFrom: null,
        attemptCount: requestResult.attemptCount,
        message: `Failed to parse robots.txt (${message}); continuing with allow-all rules`,
      },
    };
  }
}

function allowAllRobots(): RobotsLike {
  return {
    isAllowed: () => true,
  };
}
