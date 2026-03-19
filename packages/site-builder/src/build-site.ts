import { load } from "cheerio";
import fs from "fs-extra";
import { dirname, join } from "pathe";

import { locateNode } from "./dom-path";
import { rewriteLinks } from "./link-rewriter";
import type { BuildSiteOptions, BuildSiteResult } from "./types";

export async function buildSite(
  options: BuildSiteOptions,
): Promise<BuildSiteResult> {
  const {
    repoDir,
    config,
    manifest,
    segments,
    assemblyMaps,
    translations,
    logger,
  } = options;
  const siteDir = join(repoDir, "site");
  await fs.emptyDir(siteDir);

  const segmentIndex = new Map(
    segments.map((segment) => [segment.segmentId, segment]),
  );
  const translationIndex = new Map(
    translations
      .filter((translation) => translation.status === "accepted")
      .map((translation) => [translation.segmentId, translation]),
  );
  const assemblyByPage = new Map(
    assemblyMaps.map((assemblyMap) => [assemblyMap.pageUrl, assemblyMap]),
  );

  let missingTranslations = 0;

  for (const asset of Object.values(manifest.assets)) {
    const sourcePath = join(repoDir, asset.cachePath);
    const targetPath = join(siteDir, asset.outputPath);
    await fs.ensureDir(dirname(targetPath));
    await fs.copyFile(sourcePath, targetPath);
  }

  for (const page of Object.values(manifest.pages)) {
    const sourcePath = join(repoDir, page.snapshotPath);
    const html = await fs.readFile(sourcePath, "utf8");
    const $ = load(html);
    const assemblyMap = assemblyByPage.get(page.url);

    if ($("html").length > 0) {
      $("html").attr("lang", config.targetLocale);
    }

    if (assemblyMap) {
      for (const binding of assemblyMap.bindings) {
        const segment = segmentIndex.get(binding.segmentId);
        const translation = translationIndex.get(binding.segmentId);

        if (
          !segment ||
          !translation ||
          translation.sourceHash !== segment.sourceHash
        ) {
          missingTranslations += 1;
          continue;
        }

        const node = locateNode($, config, binding.domPath);
        if (!node) {
          missingTranslations += 1;
          continue;
        }

        // Apply translations against the stored DOM path instead of re-querying selectors.
        if (binding.kind === "text" && node.type === "text") {
          node.data = translation.translatedText;
          continue;
        }

        if (
          (binding.kind === "attr" || binding.kind === "meta") &&
          binding.attributeName
        ) {
          node.attribs = node.attribs ?? {};
          node.attribs[binding.attributeName] = translation.translatedText;
        }
      }
    }

    rewriteLinks($, manifest, config, page.url);

    const targetPath = join(siteDir, page.outputPath);
    await fs.ensureDir(dirname(targetPath));
    await fs.writeFile(targetPath, $.html(), "utf8");
    logger.info(`Built ${page.outputPath}`);
  }

  return {
    pageCount: Object.keys(manifest.pages).length,
    assetCount: Object.keys(manifest.assets).length,
    missingTranslations,
  };
}
