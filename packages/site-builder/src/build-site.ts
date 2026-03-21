import { availableParallelism } from "node:os";

import { load } from "cheerio";
import fs from "fs-extra";
import { dirname, join } from "pathe";

import type { TranslationInlineGroupPlan } from "@documirror/shared";
import {
  attachCommandProfile,
  createCommandProfileRecorder,
} from "@documirror/shared";

import { createDomPathLocator } from "./dom-path";
import { createLinkRewriteIndex, rewriteLinks } from "./link-rewriter";
import {
  collectRuntimeReconcilerManifestForPage,
  createRuntimeReconcilerAssetSource,
  createRuntimeReconcilerPublicAssetPath,
  hasRuntimeReconcilerEntries,
  injectRuntimeReconcilerArtifacts,
  RUNTIME_RECONCILER_ASSET_OUTPUT_PATH,
} from "./runtime-reconciler";
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
  const profiler = createCommandProfileRecorder(options.profile);

  try {
    const {
      segmentIndex,
      translationIndex,
      assemblyByPage,
      segmentsByPage,
      inlineGroupPlansByPage,
      linkRewriteIndex,
    } = await profiler.measure("prepare build state", async () => {
      await fs.emptyDir(siteDir);
      const segmentIndex = new Map(
        segments.map((segment) => [segment.segmentId, segment]),
      );

      return {
        segmentIndex,
        translationIndex: new Map(
          translations
            .filter((translation) => translation.status === "accepted")
            .map((translation) => [translation.segmentId, translation]),
        ),
        assemblyByPage: new Map(
          assemblyMaps.map((assemblyMap) => [assemblyMap.pageUrl, assemblyMap]),
        ),
        segmentsByPage: indexSegmentsByPage(segments),
        inlineGroupPlansByPage: indexInlineGroupPlansByPage(
          translations,
          segmentIndex,
        ),
        linkRewriteIndex: createLinkRewriteIndex(manifest, config),
      };
    });

    let runtimeAssetWritePromise: Promise<void> | null = null;
    const runtimeAssetSource = config.build.runtimeReconciler.enabled
      ? createRuntimeReconcilerAssetSource()
      : "";
    const runtimeAssetPublicPath = createRuntimeReconcilerPublicAssetPath(
      config.build.basePath,
    );
    const buildConcurrency = resolveBuildConcurrency();

    await profiler.measure("copy assets", async () => {
      await mapWithConcurrency(
        Object.values(manifest.assets),
        buildConcurrency,
        async (asset) => {
          const sourcePath = join(repoDir, asset.cachePath);
          const targetPath = join(siteDir, asset.outputPath);
          await fs.ensureDir(dirname(targetPath));
          await fs.copyFile(sourcePath, targetPath);
        },
      );
    });

    const ensureRuntimeAssetWritten = async (): Promise<void> => {
      if (!config.build.runtimeReconciler.enabled) {
        return;
      }

      runtimeAssetWritePromise ??= (async () => {
        const runtimeAssetTargetPath = join(
          siteDir,
          RUNTIME_RECONCILER_ASSET_OUTPUT_PATH,
        );
        await fs.ensureDir(dirname(runtimeAssetTargetPath));
        await fs.writeFile(runtimeAssetTargetPath, runtimeAssetSource, "utf8");
      })();

      await runtimeAssetWritePromise;
    };

    const pageResults = await profiler.measure("build pages", async () =>
      mapWithConcurrency(
        Object.values(manifest.pages),
        buildConcurrency,
        async (page) => {
          const sourcePath = join(repoDir, page.snapshotPath);
          const html = await fs.readFile(sourcePath, "utf8");
          const $ = load(html);
          const locateNodeByDomPath = createDomPathLocator($, config);
          const assemblyMap = assemblyByPage.get(page.url);
          const locatedBindings = new Map(
            (assemblyMap?.bindings ?? []).map((binding) => [
              binding.segmentId,
              locateNodeByDomPath(binding.domPath),
            ]),
          );
          const inlineGroupPlans =
            inlineGroupPlansByPage.get(page.url) ??
            new Map<string, TranslationInlineGroupPlan>();
          const locatedInlineCodeNodes = new Map(
            [...inlineGroupPlans.values()]
              .flatMap((plan) =>
                plan.parts
                  .filter((part) => part.kind === "code")
                  .map((part) => part.domPath),
              )
              .map((domPath) => [domPath, locateNodeByDomPath(domPath)]),
          );
          const plannedInlineGroupSegmentIds = new Set(
            [...inlineGroupPlans.values()].flatMap((plan) => plan.segmentIds),
          );
          let missingTranslations = 0;

          if ($("html").length > 0) {
            $("html").attr("lang", config.targetLocale);
          }

          if (assemblyMap) {
            for (const inlineGroupPlan of inlineGroupPlans.values()) {
              const readyToApply = inlineGroupPlan.segmentIds.every(
                (segmentId) => {
                  const segment = segmentIndex.get(segmentId);
                  const translation = translationIndex.get(segmentId);
                  return (
                    segment &&
                    translation &&
                    translation.sourceHash === segment.sourceHash
                  );
                },
              );
              if (!readyToApply) {
                missingTranslations += inlineGroupPlan.segmentIds.length;
                continue;
              }

              if (
                !applyInlineGroupPlan(
                  inlineGroupPlan,
                  segmentIndex,
                  locatedBindings,
                  locatedInlineCodeNodes,
                  locateNodeByDomPath,
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
                node.attribs[binding.attributeName] =
                  translation.translatedText;
              }
            }
          }

          rewriteLinks($, manifest, config, page.url, linkRewriteIndex);
          const runtimeManifestResult = collectRuntimeReconcilerManifestForPage(
            {
              pageUrl: page.url,
              config,
              segments: segmentsByPage.get(page.url) ?? [],
              translationIndex,
            },
          );
          if (hasRuntimeReconcilerEntries(runtimeManifestResult.manifest)) {
            await ensureRuntimeAssetWritten();
            injectRuntimeReconcilerArtifacts(
              $,
              runtimeManifestResult.manifest,
              runtimeAssetPublicPath,
            );
          }

          const targetPath = join(siteDir, page.outputPath);
          await fs.ensureDir(dirname(targetPath));
          await fs.writeFile(targetPath, $.html(), "utf8");
          logger.info(`Built ${page.outputPath}`);

          return {
            missingTranslations,
          };
        },
      ),
    );

    const missingTranslations = pageResults.reduce(
      (total, result) => total + result.missingTranslations,
      0,
    );
    const generatedAssetCount = runtimeAssetWritePromise ? 1 : 0;

    return {
      pageCount: Object.keys(manifest.pages).length,
      assetCount: Object.keys(manifest.assets).length + generatedAssetCount,
      missingTranslations,
      profile: profiler.finish(),
    };
  } catch (error) {
    throw attachCommandProfile(error, profiler.finish());
  }
}

function indexInlineGroupPlansByPage(
  translations: BuildSiteOptions["translations"],
  segmentIndex: Map<string, BuildSiteOptions["segments"][number]>,
) {
  const inlineGroupPlansByPage = new Map<
    string,
    Map<string, TranslationInlineGroupPlan>
  >();

  translations.forEach((translation) => {
    const inlineGroupPlan = translation.inlineGroupPlan;
    if (!inlineGroupPlan) {
      return;
    }

    const firstSegmentId = inlineGroupPlan.segmentIds[0];
    const firstSegment = firstSegmentId
      ? segmentIndex.get(firstSegmentId)
      : undefined;
    if (!firstSegment) {
      return;
    }

    const pagePlans =
      inlineGroupPlansByPage.get(firstSegment.pageUrl) ?? new Map();
    if (!pagePlans.has(inlineGroupPlan.groupId)) {
      pagePlans.set(inlineGroupPlan.groupId, inlineGroupPlan);
    }
    inlineGroupPlansByPage.set(firstSegment.pageUrl, pagePlans);
  });

  return inlineGroupPlansByPage;
}

function indexSegmentsByPage(segments: BuildSiteOptions["segments"]) {
  const segmentsByPage = new Map<
    string,
    BuildSiteOptions["segments"][number][]
  >();

  segments.forEach((segment) => {
    const pageSegments = segmentsByPage.get(segment.pageUrl) ?? [];
    pageSegments.push(segment);
    segmentsByPage.set(segment.pageUrl, pageSegments);
  });

  return segmentsByPage;
}

function applyInlineGroupPlan(
  inlineGroupPlan: TranslationInlineGroupPlan,
  segmentIndex: Map<string, BuildSiteOptions["segments"][number]>,
  locatedBindings: Map<string, LooseNode | null>,
  locatedInlineCodeNodes: Map<string, LooseNode | null>,
  locateNodeByDomPath: (domPath: string) => LooseNode | null,
): boolean {
  const segmentNodes = inlineGroupPlan.segmentIds
    .map((segmentId) => {
      const segment = segmentIndex.get(segmentId);
      if (!segment) {
        return null;
      }

      return (
        locatedBindings.get(segmentId) ?? locateNodeByDomPath(segment.domPath)
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

function resolveBuildConcurrency(): number {
  return Math.min(Math.max(2, Math.floor(getAvailableParallelism() / 2)), 6);
}

function getAvailableParallelism(): number {
  try {
    return availableParallelism();
  } catch {
    return 4;
  }
}

async function mapWithConcurrency<T, TResult>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<TResult>(items.length);
  let nextIndex = 0;
  let firstError: unknown;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        if (firstError) {
          return;
        }

        const currentIndex = nextIndex;
        nextIndex += 1;
        try {
          results[currentIndex] = await worker(
            items[currentIndex],
            currentIndex,
          );
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    }),
  );

  if (firstError) {
    throw firstError;
  }

  return results;
}
