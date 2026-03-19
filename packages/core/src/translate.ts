import fg from "fast-glob";
import fs from "fs-extra";
import { nanoid } from "nanoid";
import { join } from "pathe";

import {
  createTaskFile,
  createTaskItems,
  parseResultFile,
  parseTaskFile,
} from "@documirror/adapters-filequeue";
import {
  chunkSegments,
  findPendingSegments,
  markStaleTranslations,
} from "@documirror/i18n";
import type { JsonValue, Logger, SegmentRecord } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import {
  loadConfig,
  loadSegments,
  loadTranslations,
  readJson,
  writeJson,
  writeJsonl,
} from "./storage";
import type { ApplySummary, PlanSummary } from "./types";

export async function planTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<PlanSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segments = await loadSegments(paths);
  const currentTranslations = await loadTranslations(paths);
  const translations = markStaleTranslations(segments, currentTranslations);
  await writeJsonl(paths.translationsPath, translations);

  const pendingSegments = findPendingSegments(segments, translations);
  const glossary = await readJson<JsonValue[]>(paths.glossaryPath, []);
  const { coveredSegmentIds, retainedTaskCount } = await retainPendingTasks(
    paths.tasksPendingDir,
    config.sourceUrl,
    config.targetLocale,
    pendingSegments,
    logger,
  );
  const uncoveredSegments = pendingSegments.filter(
    (segment) => !coveredSegmentIds.has(segment.segmentId),
  );
  const pendingChunks = chunkSegments(uncoveredSegments);
  let createdTaskCount = 0;

  for (const chunk of pendingChunks) {
    const taskId = `task_${nanoid(10)}`;
    const task = createTaskFile(
      taskId,
      config.sourceUrl,
      config.targetLocale,
      createTaskItems(chunk),
    );
    await writeJson(join(paths.tasksPendingDir, `${taskId}.json`), {
      ...task,
      glossary,
    });
    createdTaskCount += 1;
  }

  const taskCount = retainedTaskCount + createdTaskCount;
  logger.info(
    `Planned ${pendingSegments.length} segments across ${taskCount} pending tasks (${retainedTaskCount} retained, ${createdTaskCount} created)`,
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
    const parsed = parseResultFile(await readJson(filePath, {}));

    for (const item of parsed.items) {
      const segment = segmentIndex.get(item.segmentId);
      if (!segment) {
        logger.warn(
          `Skipping unknown segment ${item.segmentId} in ${filePath}`,
        );
        continue;
      }

      if (segment.sourceHash !== item.sourceHash) {
        logger.warn(
          `Skipping stale translation for ${item.segmentId} in ${filePath}`,
        );
        continue;
      }

      translationIndex.set(item.segmentId, {
        segmentId: item.segmentId,
        targetLocale: config.targetLocale,
        translatedText: item.translatedText,
        sourceHash: item.sourceHash,
        status: "accepted",
        provider: parsed.provider,
        updatedAt: parsed.completedAt,
      });
      appliedSegments += 1;
    }

    appliedFiles += 1;
    await fs.move(
      filePath,
      join(paths.tasksAppliedDir, `${parsed.taskId}.json`),
      {
        overwrite: true,
      },
    );
  }

  await writeJsonl(paths.translationsPath, [...translationIndex.values()]);
  return {
    appliedFiles,
    appliedSegments,
  };
}

async function retainPendingTasks(
  tasksPendingDir: string,
  sourceUrl: string,
  targetLocale: string,
  pendingSegments: SegmentRecord[],
  logger: Logger,
): Promise<{ coveredSegmentIds: Set<string>; retainedTaskCount: number }> {
  const currentSegmentHashes = new Map(
    pendingSegments.map((segment) => [segment.segmentId, segment.sourceHash]),
  );
  const coveredSegmentIds = new Set<string>();
  const files = await fg("*.json", { cwd: tasksPendingDir, absolute: true });
  let retainedTaskCount = 0;

  for (const filePath of files) {
    try {
      const task = parseTaskFile(await readJson(filePath, {}));
      // Preserve still-relevant pending tasks so external agent work is not discarded.
      const isCompatibleTask =
        task.sourceUrl === sourceUrl &&
        task.targetLocale === targetLocale &&
        task.items.length > 0 &&
        task.items.every(
          (item) =>
            currentSegmentHashes.get(item.segmentId) === item.sourceHash,
        ) &&
        task.items.every((item) => !coveredSegmentIds.has(item.segmentId));

      if (!isCompatibleTask) {
        await fs.remove(filePath);
        logger.warn(`Removed stale pending task ${filePath}`);
        continue;
      }

      task.items.forEach((item) => coveredSegmentIds.add(item.segmentId));
      retainedTaskCount += 1;
    } catch (error) {
      await fs.remove(filePath);
      logger.warn(
        `Removed unreadable pending task ${filePath}: ${String(error)}`,
      );
    }
  }

  return {
    coveredSegmentIds,
    retainedTaskCount,
  };
}
