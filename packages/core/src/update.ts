import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { crawlMirror } from "./crawl";
import { extractMirror } from "./extract";
import { planTranslations } from "./translate";
import type {
  CrawlProgressUpdate,
  CrawlSummary,
  ExtractSummary,
  PlanSummary,
} from "./types";

export async function updateMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
  onCrawlProgress?: (progress: CrawlProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<{
  crawl: CrawlSummary;
  extract: ExtractSummary;
  plan: PlanSummary;
}> {
  const crawl = await crawlMirror(repoDir, logger, onCrawlProgress, signal);
  const extract = await extractMirror(repoDir, logger);
  const plan = await planTranslations(repoDir, logger);
  return { crawl, extract, plan };
}
