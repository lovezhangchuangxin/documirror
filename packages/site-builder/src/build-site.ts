import { load } from "cheerio";
import fs from "fs-extra";
import { dirname, join } from "pathe";

import type { TranslationInlineGroupPlan } from "@documirror/shared";

import { locateNode } from "./dom-path";
import { rewriteLinks } from "./link-rewriter";
import type { BuildSiteOptions, BuildSiteResult, LooseNode } from "./types";

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
    const locatedBindings = new Map(
      (assemblyMap?.bindings ?? []).map((binding) => [
        binding.segmentId,
        locateNode($, config, binding.domPath),
      ]),
    );
    const inlineGroupPlans = collectInlineGroupPlansForPage(
      page.url,
      translations,
      segmentIndex,
    );
    const locatedInlineCodeNodes = new Map(
      [...inlineGroupPlans.values()]
        .flatMap((plan) =>
          plan.parts
            .filter((part) => part.kind === "code")
            .map((part) => part.domPath),
        )
        .map((domPath) => [domPath, locateNode($, config, domPath)]),
    );
    const plannedInlineGroupSegmentIds = new Set(
      [...inlineGroupPlans.values()].flatMap((plan) => plan.segmentIds),
    );

    if ($("html").length > 0) {
      $("html").attr("lang", config.targetLocale);
    }

    if (assemblyMap) {
      for (const inlineGroupPlan of inlineGroupPlans.values()) {
        const readyToApply = inlineGroupPlan.segmentIds.every((segmentId) => {
          const segment = segmentIndex.get(segmentId);
          const translation = translationIndex.get(segmentId);
          return (
            segment &&
            translation &&
            translation.sourceHash === segment.sourceHash
          );
        });
        if (!readyToApply) {
          missingTranslations += inlineGroupPlan.segmentIds.length;
          continue;
        }

        if (
          !applyInlineGroupPlan(
            $,
            config,
            inlineGroupPlan,
            segmentIndex,
            locatedBindings,
            locatedInlineCodeNodes,
          )
        ) {
          missingTranslations += inlineGroupPlan.segmentIds.length;
          continue;
        }
      }

      for (const binding of assemblyMap.bindings) {
        if (plannedInlineGroupSegmentIds.has(binding.segmentId)) {
          continue;
        }

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

        const node = locatedBindings.get(binding.segmentId) ?? null;
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

function collectInlineGroupPlansForPage(
  pageUrl: string,
  translations: BuildSiteOptions["translations"],
  segmentIndex: Map<string, BuildSiteOptions["segments"][number]>,
): Map<string, TranslationInlineGroupPlan> {
  const inlineGroupPlans = new Map<string, TranslationInlineGroupPlan>();

  translations.forEach((translation) => {
    const inlineGroupPlan = translation.inlineGroupPlan;
    if (!inlineGroupPlan || inlineGroupPlans.has(inlineGroupPlan.groupId)) {
      return;
    }

    const firstSegmentId = inlineGroupPlan.segmentIds[0];
    const firstSegment = firstSegmentId
      ? segmentIndex.get(firstSegmentId)
      : undefined;
    if (!firstSegment || firstSegment.pageUrl !== pageUrl) {
      return;
    }

    inlineGroupPlans.set(inlineGroupPlan.groupId, inlineGroupPlan);
  });

  return inlineGroupPlans;
}

function applyInlineGroupPlan(
  $: ReturnType<typeof load>,
  config: BuildSiteOptions["config"],
  inlineGroupPlan: TranslationInlineGroupPlan,
  segmentIndex: Map<string, BuildSiteOptions["segments"][number]>,
  locatedBindings: Map<string, LooseNode | null>,
  locatedInlineCodeNodes: Map<string, LooseNode | null>,
): boolean {
  const segmentNodes = inlineGroupPlan.segmentIds
    .map((segmentId) => {
      const segment = segmentIndex.get(segmentId);
      if (!segment) {
        return null;
      }

      return (
        locatedBindings.get(segmentId) ?? locateNode($, config, segment.domPath)
      );
    })
    .filter(Boolean) as LooseNode[];
  const codeNodes = inlineGroupPlan.parts
    .filter((part) => part.kind === "code")
    .map((part) => locatedInlineCodeNodes.get(part.domPath) ?? null)
    .filter(Boolean) as LooseNode[];
  const groupNodes = [...segmentNodes, ...codeNodes];
  const parent = groupNodes[0]?.parent;

  if (!parent || !parent.children) {
    return false;
  }

  if (groupNodes.some((node) => node.parent !== parent)) {
    return false;
  }

  const childIndices = groupNodes
    .map((node) => parent.children?.indexOf(node) ?? -1)
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  const startIndex = childIndices[0];
  const endIndex = childIndices[childIndices.length - 1];
  if (
    startIndex === undefined ||
    endIndex === undefined ||
    childIndices.length !== groupNodes.length
  ) {
    return false;
  }

  const codeNodeByDomPath = new Map(
    inlineGroupPlan.parts
      .filter((part) => part.kind === "code")
      .map((part) => [part.domPath, locatedInlineCodeNodes.get(part.domPath)]),
  );
  const replacementChildren = inlineGroupPlan.parts.flatMap((part) => {
    if (part.kind === "text") {
      if (part.translatedText.length === 0) {
        return [];
      }

      return [createTextNode(part.translatedText)];
    }

    const codeNode = codeNodeByDomPath.get(part.domPath);
    return codeNode ? [codeNode] : [];
  });
  if (
    replacementChildren.length !==
    inlineGroupPlan.parts.filter((part) =>
      part.kind === "code" ? true : part.translatedText.length > 0,
    ).length
  ) {
    return false;
  }

  replaceChildRange(parent, startIndex, endIndex, replacementChildren);
  return true;
}

function createTextNode(text: string): LooseNode {
  return {
    type: "text",
    data: text,
    parent: null,
    prev: null,
    next: null,
  };
}

function replaceChildRange(
  parent: LooseNode,
  startIndex: number,
  endIndex: number,
  replacementChildren: LooseNode[],
): void {
  const before = parent.children?.slice(0, startIndex) ?? [];
  const after = parent.children?.slice(endIndex + 1) ?? [];
  const nextChildren = [...before, ...replacementChildren, ...after];

  nextChildren.forEach((child, index) => {
    child.parent = parent;
    child.prev = nextChildren[index - 1] ?? null;
    child.next = nextChildren[index + 1] ?? null;
  });

  parent.children = nextChildren;
}
