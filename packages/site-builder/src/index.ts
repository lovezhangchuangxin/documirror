import { URL } from "node:url";

import { load } from "cheerio";
import fs from "fs-extra";
import { dirname, join } from "pathe";

import type {
  AssemblyMap,
  Logger,
  Manifest,
  MirrorConfig,
  SegmentRecord,
  TranslationRecord,
} from "@documirror/shared";

type LooseNode = {
  type?: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: LooseNode[];
};

export type BuildSiteOptions = {
  repoDir: string;
  config: MirrorConfig;
  manifest: Manifest;
  segments: SegmentRecord[];
  assemblyMaps: AssemblyMap[];
  translations: TranslationRecord[];
  logger: Logger;
};

export type BuildSiteResult = {
  pageCount: number;
  assetCount: number;
  missingTranslations: number;
};

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

function rewriteLinks(
  $: ReturnType<typeof load>,
  manifest: Manifest,
  config: MirrorConfig,
  pageUrl: string,
): void {
  const pageMap = new Map(
    Object.values(manifest.pages).map((page) => [
      page.url,
      toPublicPath(page.outputPath, config.build.basePath),
    ]),
  );
  const assetMap = new Map(
    Object.values(manifest.assets).map((asset) => [
      asset.url,
      toPublicPath(asset.outputPath, config.build.basePath),
    ]),
  );

  $("[href], [src]").each((_, element) => {
    const href = $(element).attr("href");
    const src = $(element).attr("src");
    if (href) {
      const rewritten = rewriteUrl(href, pageUrl, pageMap, assetMap);
      if (rewritten) {
        $(element).attr("href", rewritten);
      }
    }
    if (src) {
      const rewritten = rewriteUrl(src, pageUrl, pageMap, assetMap);
      if (rewritten) {
        $(element).attr("src", rewritten);
      }
    }
  });
}

function rewriteUrl(
  rawValue: string,
  sourceUrl: string,
  pageMap: Map<string, string>,
  assetMap: Map<string, string>,
): string | null {
  if (
    rawValue.startsWith("#") ||
    rawValue.startsWith("mailto:") ||
    rawValue.startsWith("tel:") ||
    rawValue.startsWith("javascript:")
  ) {
    return null;
  }

  const resolved = new URL(rawValue, sourceUrl);
  const normalized = resolved.toString().replace(/#.*$/, "");
  return pageMap.get(normalized) ?? assetMap.get(normalized) ?? null;
}

function toPublicPath(outputPath: string, basePath: string): string {
  const prefix = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  if (outputPath === "index.html") {
    return `${prefix || ""}/`;
  }

  if (outputPath.endsWith("/index.html")) {
    return `${prefix}/${outputPath.slice(0, -"index.html".length)}`;
  }

  return `${prefix}/${outputPath}`;
}

function locateNode(
  $: ReturnType<typeof load>,
  config: MirrorConfig,
  domPath: string,
): LooseNode | null {
  const roots =
    config.selectors.include.length > 0
      ? config.selectors.include.flatMap((selector) => $(selector).toArray())
      : [$("body").get(0) ?? $.root().get(0)];

  const parts = domPath.split("/");
  const rootPart = parts.shift();
  if (!rootPart) {
    return null;
  }

  const rootMatch = rootPart.match(/^root\[(\d+)\]$/);
  if (!rootMatch) {
    return null;
  }

  let current = roots[Number(rootMatch[1])] as LooseNode | undefined;
  for (const part of parts) {
    const match = part.match(/^[^[]+\[(\d+)\]$/);
    if (!match || !current?.children) {
      return null;
    }

    current = current.children[Number(match[1])];
  }

  return current ?? null;
}
