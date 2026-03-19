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

export type RobotsLike = {
  isAllowed: (url: string, userAgent: string) => boolean;
};
