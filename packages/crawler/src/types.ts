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

export type CrawlIssueKind =
  | "page-fetch"
  | "asset-fetch"
  | "robots"
  | "invalid-link";

export type CrawlIssueSeverity = "warn" | "error";

export type CrawlIssue = {
  kind: CrawlIssueKind;
  severity: CrawlIssueSeverity;
  url: string;
  message: string;
  discoveredFrom: string | null;
  statusCode?: number;
  code?: string;
  attemptCount?: number;
};

export type CrawlStats = {
  pageFailures: number;
  assetFailures: number;
  invalidLinks: number;
  skippedByRobots: number;
  retriedRequests: number;
  timedOutRequests: number;
  robotsFailures: number;
};

export type CrawlResult = {
  pageCount: number;
  assetCount: number;
  issues: CrawlIssue[];
  stats: CrawlStats;
};

export type RobotsLike = {
  isAllowed: (url: string, userAgent: string) => boolean;
};

export type CrawlSink = {
  onPage?: (page: CrawledPage) => void | Promise<void>;
  onAsset?: (asset: CrawledAsset) => void | Promise<void>;
};

export type InvalidLinkReference = {
  rawValue: string;
  tagName: string;
  attributeName: string;
};

export type LinkDiscoveryResult = {
  pageLinks: string[];
  assetUrls: string[];
  invalidLinks: InvalidLinkReference[];
};
