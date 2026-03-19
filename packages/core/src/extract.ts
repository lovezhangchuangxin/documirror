import fs from "fs-extra";
import { join } from "pathe";

import { extractSegmentsFromHtml } from "@documirror/parser";
import type { AssemblyMap, Logger, SegmentRecord } from "@documirror/shared";
import { createTimestamp, defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import { loadConfig, loadManifest, writeJson, writeJsonl } from "./storage";
import type { ExtractSummary } from "./types";

export async function extractMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<ExtractSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);

  const segments: SegmentRecord[] = [];
  const assemblyMaps: AssemblyMap[] = [];

  for (const page of Object.values(manifest.pages)) {
    const html = await fs.readFile(join(repoDir, page.snapshotPath), "utf8");
    const extracted = extractSegmentsFromHtml(html, page.url, config);
    segments.push(...extracted.segments);
    assemblyMaps.push(extracted.assemblyMap);
    manifest.pages[page.url] = {
      ...page,
      extractedAt: createTimestamp(),
    };
    logger.info(
      `Extracted ${extracted.segments.length} segments from ${page.url}`,
    );
  }

  await writeJsonl(paths.segmentsPath, segments);
  await writeJson(paths.assemblyPath, assemblyMaps);
  await writeJson(paths.manifestPath, manifest);

  return {
    pageCount: Object.keys(manifest.pages).length,
    segmentCount: segments.length,
  };
}
