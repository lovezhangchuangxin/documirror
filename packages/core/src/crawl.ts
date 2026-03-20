import fs from "fs-extra";
import pLimit from "p-limit";
import { dirname, join, relative } from "pathe";

import { crawlWebsite } from "@documirror/crawler";
import type { Logger, Manifest, PageRecord } from "@documirror/shared";
import {
  createCacheFileName,
  createTimestamp,
  defaultLogger,
  hashBuffer,
  hashString,
  manifestSchema,
} from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import { ensureRepoStructure, loadConfig, writeJson } from "./storage";
import type { CrawlProgressUpdate, CrawlSummary } from "./types";

export async function crawlMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
  onProgress?: (progress: CrawlProgressUpdate) => void,
  signal?: AbortSignal,
): Promise<CrawlSummary> {
  const paths = getRepoPaths(repoDir);
  await ensureRepoStructure(paths);
  const config = await loadConfig(paths);
  const manifest: Manifest = manifestSchema.parse({
    sourceUrl: config.sourceUrl,
    targetLocale: config.targetLocale,
    generatedAt: createTimestamp(),
    pages: {},
    assets: {},
  });
  const writeLimit = pLimit(Math.max(1, Math.min(config.crawlConcurrency, 8)));

  const crawlResult = await crawlWebsite(config, logger, {
    signal,
    onProgress(progress) {
      onProgress?.(progress);
    },
    onPage(page) {
      return writeLimit(async () => {
        const snapshotRelativePath = relative(
          repoDir,
          join(paths.pagesCacheDir, createCacheFileName(page.url, ".html")),
        );
        const snapshotPath = join(repoDir, snapshotRelativePath);
        await fs.ensureDir(dirname(snapshotPath));
        await fs.writeFile(snapshotPath, page.html, "utf8");

        const record: PageRecord = {
          url: page.url,
          canonicalUrl: page.canonicalUrl,
          status: page.status,
          contentType: page.contentType,
          snapshotPath: snapshotRelativePath,
          outputPath: page.outputPath,
          pageHash: hashString(page.html),
          discoveredFrom: page.discoveredFrom,
          assetRefs: page.assetRefs,
        };

        manifest.pages[page.url] = record;
      });
    },
    onAsset(asset) {
      return writeLimit(async () => {
        const cacheRelativePath = relative(
          repoDir,
          join(paths.assetsCacheDir, asset.outputPath),
        );
        const cachePath = join(repoDir, cacheRelativePath);
        await fs.ensureDir(dirname(cachePath));
        await fs.writeFile(cachePath, asset.buffer);

        manifest.assets[asset.url] = {
          url: asset.url,
          cachePath: cacheRelativePath,
          outputPath: asset.outputPath,
          contentType: asset.contentType,
          contentHash: hashBuffer(asset.buffer),
        };
      });
    },
  });

  manifest.generatedAt = createTimestamp();
  await writeJson(paths.manifestPath, manifestSchema.parse(manifest));

  return {
    pageCount: crawlResult.pageCount,
    assetCount: crawlResult.assetCount,
    issueCount: crawlResult.issues.length,
    issues: crawlResult.issues,
    stats: crawlResult.stats,
  };
}
