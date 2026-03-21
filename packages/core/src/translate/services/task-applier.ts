import fs from "fs-extra";

import { parseResultFile, parseTaskFile } from "@documirror/adapters-filequeue";
import type {
  Logger,
  SegmentRecord,
  TranslationTaskMappingEntry,
} from "@documirror/shared";

import type { RepoPaths } from "../../types";
import type { loadTranslations } from "../../storage";
import { readJson } from "../../storage";
import type { PreparedApplyTaskBundle, SegmentIndex } from "../internal-types";
import { buildInlineGroupPlan } from "../domain/inline-groups";
import {
  validateTaskFreshness,
  validateTaskStructure,
  validateTranslationsAgainstTask,
} from "../domain/verification";
import { getPendingTaskPath, loadTaskMapping } from "../infra/task-repository";

type TranslationStateRecord = Awaited<
  ReturnType<typeof loadTranslations>
>[number];

export async function prepareApplyTaskBundle(options: {
  filePath: string;
  paths: RepoPaths;
  segmentIndex: SegmentIndex;
  logger: Logger;
}): Promise<PreparedApplyTaskBundle | null> {
  const { filePath, paths, segmentIndex, logger } = options;
  let result;
  try {
    result = parseResultFile(await readJson(filePath, {}));
  } catch (error) {
    logger.warn(
      `Skipping unreadable result file ${filePath}: ${String(error)}`,
    );
    return null;
  }

  const taskPath = getPendingTaskPath(paths, result.taskId);
  if (!(await fs.pathExists(taskPath))) {
    logger.warn(
      `Skipping result import for ${result.taskId} because its pending task file is missing`,
    );
    return null;
  }

  const task = parseTaskFile(await readJson(taskPath, {}));
  const mapping = await loadTaskMapping(paths.taskMappingsDir, result.taskId);
  if (!mapping) {
    logger.warn(
      `Skipping result import for ${result.taskId} because its task mapping is missing or unreadable`,
    );
    return null;
  }

  const issues = [
    ...validateTaskStructure(task),
    ...validateTaskFreshness(task, mapping, segmentIndex),
    ...validateTranslationsAgainstTask(task, mapping, result),
  ];
  if (issues.length > 0) {
    logger.warn(
      `Skipping result import for ${result.taskId} because verification failed`,
    );
    issues.forEach((issue) => {
      logger.warn(`[${issue.code}] ${issue.jsonPath}: ${issue.message}`);
    });
    return null;
  }

  return {
    filePath,
    result,
    mapping,
  };
}

export function applyMappedTranslation(options: {
  mappedItem: TranslationTaskMappingEntry;
  translatedText: string;
  targetLocale: string;
  provider: string;
  completedAt: string;
  filePath: string;
  segmentIndex: Map<string, SegmentRecord>;
  translationIndex: Map<string, TranslationStateRecord>;
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
      reuseKey: segment.reuseKey,
      targetLocale,
      translatedText,
      sourceHash: mappedItem.segment.sourceHash,
      status: "accepted",
      provider,
      updatedAt: completedAt,
    });
    return 1;
  }

  const inlineGroupPlan = buildInlineGroupPlan(mappedItem, translatedText);
  if (!inlineGroupPlan.ok) {
    logger.warn(
      `Skipping inline-code translation ${mappedItem.id} in ${filePath} because required inline code spans were not preserved`,
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
    const currentSegment = segmentIndex.get(segmentRef.segmentId);
    translationIndex.set(segmentRef.segmentId, {
      segmentId: segmentRef.segmentId,
      reuseKey: currentSegment?.reuseKey,
      targetLocale,
      translatedText: inlineGroupPlan.projectedSegmentTexts[index] ?? "",
      sourceHash: segmentRef.sourceHash,
      status: "accepted",
      provider,
      updatedAt: completedAt,
      inlineGroupPlan: inlineGroupPlan.plan,
    });
  });

  return mappedItem.segments.length;
}
