import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { crawlMirror } from "./crawl";
import { extractMirror } from "./extract";
import { planTranslations } from "./translate";
import type { CrawlSummary, ExtractSummary, PlanSummary } from "./types";

export async function updateMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<{
  crawl: CrawlSummary;
  extract: ExtractSummary;
  plan: PlanSummary;
}> {
  const crawl = await crawlMirror(repoDir, logger);
  const extract = await extractMirror(repoDir, logger);
  const plan = await planTranslations(repoDir, logger);
  return { crawl, extract, plan };
}
