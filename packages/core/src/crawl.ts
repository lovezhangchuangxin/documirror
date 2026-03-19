import fs from "fs-extra";
import { dirname, join, relative } from "pathe";

import { crawlWebsite } from "@documirror/crawler";
import type { Logger, Manifest, PageRecord } from "@documirror/shared";
import {
  createCacheFileName,
  createTimestamp,
  defaultLogger,
  hashString,
  manifestSchema,
} from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import { ensureRepoStructure, loadConfig, writeJson } from "./storage";
import type { CrawlSummary } from "./types";

export async function crawlMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<CrawlSummary> {
  const paths = getRepoPaths(repoDir);
  await ensureRepoStructure(paths);
  const config = await loadConfig(paths);
  const crawlResult = await crawlWebsite(config, logger);

  const manifest: Manifest = manifestSchema.parse({
    sourceUrl: config.sourceUrl,
    targetLocale: config.targetLocale,
    generatedAt: createTimestamp(),
    pages: {},
    assets: {},
  });

  for (const page of crawlResult.pages) {
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
  }

  for (const asset of crawlResult.assets) {
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
      contentHash: hashString(asset.buffer.toString("base64")),
    };
  }

  await writeJson(paths.manifestPath, manifestSchema.parse(manifest));
  return {
    pageCount: crawlResult.pages.length,
    assetCount: crawlResult.assets.length,
  };
}
