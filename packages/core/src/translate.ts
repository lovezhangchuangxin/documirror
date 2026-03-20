import fg from "fast-glob";
import fs from "fs-extra";
import { nanoid } from "nanoid";
import { basename, join } from "pathe";

import {
  createTaskBundle,
  parseResultFile,
  parseTaskFile,
  parseTaskMappingFile,
} from "@documirror/adapters-filequeue";
import { findPendingSegments, markStaleTranslations } from "@documirror/i18n";
import {
  buildTranslationTaskUnits,
  type TranslationTaskUnit,
} from "@documirror/parser";
import type {
  JsonValue,
  Logger,
  Manifest,
  SegmentRecord,
  TranslationTaskMappingEntry,
  TranslationTaskMappingFile,
} from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import {
  loadConfig,
  loadManifest,
  loadSegments,
  loadTranslations,
  readJson,
  writeJson,
  writeJsonl,
} from "./storage";
import type { ApplySummary, PlanSummary } from "./types";

type PlannedPageTask = {
  pageUrl: string;
  units: TranslationTaskUnit[];
};

export async function planTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<PlanSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const currentTranslations = await loadTranslations(paths);
  const translations = markStaleTranslations(segments, currentTranslations);
  await writeJsonl(paths.translationsPath, translations);

  const pendingSegments = findPendingSegments(segments, translations);
  const plannedPages = await buildPlannedPageTasks(
    repoDir,
    config,
    manifest,
    segments,
    pendingSegments,
  );
  const glossary = await readJson<JsonValue[]>(paths.glossaryPath, []);
  const { retainedPageUrls, retainedTaskCount } = await retainPendingTasks(
    paths.taskMappingsDir,
    paths.tasksPendingDir,
    config.sourceUrl,
    config.targetLocale,
    plannedPages,
    logger,
  );
  const createdPages = plannedPages.filter(
    (plannedPage) => !retainedPageUrls.has(plannedPage.pageUrl),
  );
  let createdTaskCount = 0;

  for (const plannedPage of createdPages) {
    const taskId = `task_${nanoid(10)}`;
    const { task, mapping } = createTaskBundle(
      taskId,
      config.sourceUrl,
      config.targetLocale,
      plannedPage.units,
    );

    await writeJson(join(paths.tasksPendingDir, `${taskId}.json`), {
      ...task,
      glossary,
    });
    await writeJson(getTaskMappingPath(paths.taskMappingsDir, taskId), mapping);
    createdTaskCount += 1;
  }

  const taskCount = retainedTaskCount + createdTaskCount;
  logger.info(
    `Planned ${pendingSegments.length} segments across ${taskCount} pending page tasks (${retainedTaskCount} retained, ${createdTaskCount} created)`,
  );
  return {
    taskCount,
    segmentCount: pendingSegments.length,
  };
}

export async function applyTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<ApplySummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segments = await loadSegments(paths);
  const segmentIndex = new Map(
    segments.map((segment) => [segment.segmentId, segment]),
  );
  const translations = await loadTranslations(paths);
  const translationIndex = new Map(
    translations.map((translation) => [translation.segmentId, translation]),
  );
  const files = await fg("*.json", { cwd: paths.tasksDoneDir, absolute: true });

  let appliedFiles = 0;
  let appliedSegments = 0;

  for (const filePath of files) {
    let parsed;
    try {
      parsed = parseResultFile(await readJson(filePath, {}));
    } catch (error) {
      logger.warn(
        `Skipping unreadable result file ${filePath}: ${String(error)}`,
      );
      continue;
    }

    const mapping = await loadTaskMapping(paths.taskMappingsDir, parsed.taskId);

    if (!mapping) {
      logger.warn(
        `Skipping result import for ${parsed.taskId} because its task mapping is missing or unreadable`,
      );
      continue;
    }

    const mappingIndex = new Map(mapping.items.map((item) => [item.id, item]));

    for (const item of parsed.translations) {
      const mappedItem = mappingIndex.get(item.id);
      if (!mappedItem) {
        logger.warn(
          `Skipping unknown translation id ${item.id} in ${filePath}`,
        );
        continue;
      }

      const appliedCount = applyMappedTranslation({
        mappedItem,
        translatedText: item.translatedText,
        targetLocale: config.targetLocale,
        provider: parsed.provider,
        completedAt: parsed.completedAt,
        filePath,
        segmentIndex,
        translationIndex,
        logger,
      });
      appliedSegments += appliedCount;
    }

    await fs.remove(join(paths.tasksPendingDir, `${parsed.taskId}.json`));
    await archiveTaskMapping(
      paths.taskMappingsDir,
      paths.tasksAppliedDir,
      parsed.taskId,
    );
    await fs.move(
      filePath,
      join(paths.tasksAppliedDir, `${parsed.taskId}.json`),
      {
        overwrite: true,
      },
    );
    appliedFiles += 1;
  }

  await writeJsonl(paths.translationsPath, [...translationIndex.values()]);
  return {
    appliedFiles,
    appliedSegments,
  };
}

async function buildPlannedPageTasks(
  repoDir: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
  manifest: Manifest,
  segments: SegmentRecord[],
  pendingSegments: SegmentRecord[],
): Promise<PlannedPageTask[]> {
  const allSegmentsByPage = new Map(
    groupSegmentsByPage(segments).map((pageSegments) => [
      pageSegments[0]?.pageUrl ?? "",
      pageSegments,
    ]),
  );
  const pendingSegmentsByPage = groupSegmentsByPage(pendingSegments);
  const plannedPages: PlannedPageTask[] = [];

  for (const pendingPageSegments of pendingSegmentsByPage) {
    const pageUrl = pendingPageSegments[0]?.pageUrl;
    if (!pageUrl) {
      continue;
    }

    const pageSegments = allSegmentsByPage.get(pageUrl);
    if (!pageSegments) {
      throw new Error(`Missing extracted segments for pending page ${pageUrl}`);
    }

    const page = manifest.pages[pageUrl];
    if (!page) {
      throw new Error(`Missing manifest entry for pending page ${pageUrl}`);
    }

    const html = await fs.readFile(join(repoDir, page.snapshotPath), "utf8");
    const pendingSegmentIds = new Set(
      pendingPageSegments.map((segment) => segment.segmentId),
    );
    plannedPages.push({
      pageUrl,
      units: buildTranslationTaskUnits(
        html,
        pageUrl,
        config,
        pageSegments,
      ).filter((unit) =>
        unit.segments.some((segment) =>
          pendingSegmentIds.has(segment.segmentId),
        ),
      ),
    });
  }

  return plannedPages;
}

async function retainPendingTasks(
  taskMappingsDir: string,
  tasksPendingDir: string,
  sourceUrl: string,
  targetLocale: string,
  plannedPages: PlannedPageTask[],
  logger: Logger,
): Promise<{ retainedPageUrls: Set<string>; retainedTaskCount: number }> {
  const plannedPagesByUrl = new Map(
    plannedPages.map((plannedPage) => [plannedPage.pageUrl, plannedPage]),
  );
  const retainedPageUrls = new Set<string>();
  const files = await fg("*.json", { cwd: tasksPendingDir, absolute: true });
  let retainedTaskCount = 0;

  for (const filePath of files) {
    try {
      const task = parseTaskFile(await readJson(filePath, {}));
      const mapping = await loadRequiredTaskMapping(
        taskMappingsDir,
        task.taskId,
      );
      const plannedPage = plannedPagesByUrl.get(task.page.url);
      const expectedBundle = plannedPage
        ? createTaskBundle(
            task.taskId,
            sourceUrl,
            targetLocale,
            plannedPage.units,
          )
        : null;
      const isCompatibleTask =
        task.sourceUrl === sourceUrl &&
        task.targetLocale === targetLocale &&
        mapping.sourceUrl === sourceUrl &&
        mapping.targetLocale === targetLocale &&
        !retainedPageUrls.has(task.page.url) &&
        plannedPage !== undefined &&
        isSerializedEqual(task.page, expectedBundle?.task.page) &&
        isSerializedEqual(task.content, expectedBundle?.task.content) &&
        isSerializedEqual(mapping.page, expectedBundle?.mapping.page) &&
        isSerializedEqual(mapping.items, expectedBundle?.mapping.items);

      if (!isCompatibleTask) {
        await removePendingTaskBundle(taskMappingsDir, filePath, task.taskId);
        logger.warn(`Removed stale pending task ${filePath}`);
        continue;
      }

      retainedPageUrls.add(task.page.url);
      retainedTaskCount += 1;
    } catch (error) {
      const taskId = getTaskIdFromPath(filePath);
      await removePendingTaskBundle(taskMappingsDir, filePath, taskId);
      logger.warn(
        `Removed unreadable pending task ${filePath}: ${String(error)}`,
      );
    }
  }

  return {
    retainedPageUrls,
    retainedTaskCount,
  };
}

function applyMappedTranslation(options: {
  mappedItem: TranslationTaskMappingEntry;
  translatedText: string;
  targetLocale: string;
  provider: string;
  completedAt: string;
  filePath: string;
  segmentIndex: Map<string, SegmentRecord>;
  translationIndex: Map<
    string,
    Awaited<ReturnType<typeof loadTranslations>>[number]
  >;
  logger: Logger;
}): number {
  const {
    mappedItem,
    translatedText,
    targetLocale,
    provider,
    completedAt,
    filePath,
    segmentIndex,
    translationIndex,
    logger,
  } = options;

  if (mappedItem.kind === "segment") {
    const segment = segmentIndex.get(mappedItem.segment.segmentId);
    if (!segment) {
      logger.warn(
        `Skipping unknown segment ${mappedItem.segment.segmentId} in ${filePath}`,
      );
      return 0;
    }

    if (segment.sourceHash !== mappedItem.segment.sourceHash) {
      logger.warn(
        `Skipping stale translation for ${mappedItem.segment.segmentId} in ${filePath}`,
      );
      return 0;
    }

    translationIndex.set(mappedItem.segment.segmentId, {
      segmentId: mappedItem.segment.segmentId,
      targetLocale,
      translatedText,
      sourceHash: mappedItem.segment.sourceHash,
      status: "accepted",
      provider,
      updatedAt: completedAt,
    });
    return 1;
  }

  const translatedSegments = splitByInlineCodeSpans(
    translatedText,
    mappedItem.inlineCodeSpans.map((inlineCodeSpan) => inlineCodeSpan.text),
    mappedItem.textSlotIndices,
  );
  if (!translatedSegments) {
    logger.warn(
      `Skipping inline-code translation ${mappedItem.id} in ${filePath} because inline code spans were not preserved in order`,
    );
    return 0;
  }

  const staleSegment = mappedItem.segments.find((segmentRef) => {
    const currentSegment = segmentIndex.get(segmentRef.segmentId);
    return (
      !currentSegment || currentSegment.sourceHash !== segmentRef.sourceHash
    );
  });
  if (staleSegment) {
    logger.warn(
      `Skipping stale translation for ${staleSegment.segmentId} in ${filePath}`,
    );
    return 0;
  }

  mappedItem.segments.forEach((segmentRef, index) => {
    translationIndex.set(segmentRef.segmentId, {
      segmentId: segmentRef.segmentId,
      targetLocale,
      translatedText: translatedSegments[index] ?? "",
      sourceHash: segmentRef.sourceHash,
      status: "accepted",
      provider,
      updatedAt: completedAt,
    });
  });

  return mappedItem.segments.length;
}

function splitByInlineCodeSpans(
  translatedText: string,
  expectedInlineCodeSpans: string[],
  expectedTextSlotIndices: number[],
): string[] | null {
  const parsed = parseInlineCodeSpans(translatedText);
  if (!parsed) {
    return null;
  }

  if (parsed.inlineCodeSpans.length !== expectedInlineCodeSpans.length) {
    return null;
  }

  if (
    parsed.inlineCodeSpans.some(
      (inlineCodeSpan, index) =>
        inlineCodeSpan !== expectedInlineCodeSpans[index],
    )
  ) {
    return null;
  }

  const expectedTextSlotIndexSet = new Set(expectedTextSlotIndices);
  const hasUnexpectedTextInUnusedSlot = parsed.textSegments.some(
    (textSegment, slotIndex) =>
      !expectedTextSlotIndexSet.has(slotIndex) && textSegment.trim() !== "",
  );
  if (hasUnexpectedTextInUnusedSlot) {
    return null;
  }

  return expectedTextSlotIndices.map(
    (slotIndex) => parsed.textSegments[slotIndex] ?? "",
  );
}

function groupSegmentsByPage(segments: SegmentRecord[]): SegmentRecord[][] {
  const pages = new Map<string, SegmentRecord[]>();

  segments.forEach((segment) => {
    const pageSegments = pages.get(segment.pageUrl) ?? [];
    pageSegments.push(segment);
    pages.set(segment.pageUrl, pageSegments);
  });

  return [...pages.values()];
}

function getTaskMappingPath(taskMappingsDir: string, taskId: string): string {
  return join(taskMappingsDir, `${taskId}.json`);
}

function getAppliedTaskMappingPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.mapping.json`);
}

function getTaskIdFromPath(filePath: string): string {
  return basename(filePath, ".json");
}

async function loadRequiredTaskMapping(
  taskMappingsDir: string,
  taskId: string,
): Promise<TranslationTaskMappingFile> {
  return parseTaskMappingFile(
    await readJson(getTaskMappingPath(taskMappingsDir, taskId), {}),
  );
}

async function loadTaskMapping(
  taskMappingsDir: string,
  taskId: string,
): Promise<TranslationTaskMappingFile | null> {
  try {
    return await loadRequiredTaskMapping(taskMappingsDir, taskId);
  } catch {
    return null;
  }
}

async function removePendingTaskBundle(
  taskMappingsDir: string,
  taskFilePath: string,
  taskId: string,
): Promise<void> {
  await fs.remove(taskFilePath);
  if (taskId) {
    await fs.remove(getTaskMappingPath(taskMappingsDir, taskId));
  }
}

async function archiveTaskMapping(
  taskMappingsDir: string,
  tasksAppliedDir: string,
  taskId: string,
): Promise<void> {
  const mappingPath = getTaskMappingPath(taskMappingsDir, taskId);
  if (!(await fs.pathExists(mappingPath))) {
    return;
  }

  await fs.move(
    mappingPath,
    getAppliedTaskMappingPath(tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
}

function isSerializedEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseInlineCodeSpans(
  value: string,
): { textSegments: string[]; inlineCodeSpans: string[] } | null {
  const textSegments: string[] = [];
  const inlineCodeSpans: string[] = [];
  let cursor = 0;
  let textBuffer = "";

  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      textBuffer += value[cursor];
      cursor += 1;
      continue;
    }

    const fenceLength = countBackticks(value, cursor);
    const fence = "`".repeat(fenceLength);
    const contentStart = cursor + fenceLength;
    const contentEnd = value.indexOf(fence, contentStart);
    if (contentEnd < 0) {
      return null;
    }

    textSegments.push(textBuffer);
    textBuffer = "";
    inlineCodeSpans.push(value.slice(contentStart, contentEnd));
    cursor = contentEnd + fenceLength;
  }

  textSegments.push(textBuffer);
  return {
    textSegments,
    inlineCodeSpans,
  };
}

function countBackticks(value: string, startIndex: number): number {
  let length = 0;

  while (value[startIndex + length] === "`") {
    length += 1;
  }

  return length;
}
