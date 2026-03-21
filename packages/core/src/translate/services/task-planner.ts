import fs from "fs-extra";
import { basename, join } from "pathe";

import {
  createTaskBundle,
  parseTaskFile,
} from "@documirror/adapters-filequeue";
import { buildTranslationTaskUnits } from "@documirror/parser";
import type { Logger, Manifest, SegmentRecord } from "@documirror/shared";
import { hashString } from "@documirror/shared";

import type { RepoPaths } from "../../types";
import type { loadConfig } from "../../storage";
import { readJson } from "../../storage";
import type {
  PlannedPageTask,
  RetainPendingTasksResult,
} from "../internal-types";
import {
  isSerializedEqual,
  listTaskFiles,
  loadRequiredTaskMapping,
  removePendingTaskBundle,
} from "../infra/task-repository";

export async function buildPlannedPageTasks(
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

export async function retainPendingTasks(
  paths: RepoPaths,
  sourceUrl: string,
  targetLocale: string,
  plannedPages: PlannedPageTask[],
  logger: Logger,
): Promise<RetainPendingTasksResult> {
  const plannedPagesByUrl = new Map(
    plannedPages.map((plannedPage) => [plannedPage.pageUrl, plannedPage]),
  );
  const retainedPageUrls = new Set<string>();
  const files = await listTaskFiles(paths.tasksPendingDir, "*.json");
  const invalidatedTaskIds: string[] = [];
  let retainedTaskCount = 0;

  for (const filePath of files) {
    const fileName = basename(filePath);
    try {
      const task = parseTaskFile(await readJson(filePath, {}));
      const mapping = await loadRequiredTaskMapping(
        paths.taskMappingsDir,
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
        invalidatedTaskIds.push(task.taskId);
        await removePendingTaskBundle(paths, filePath, task.taskId);
        logger.warn(`Removed stale pending task ${filePath}`);
        continue;
      }

      retainedPageUrls.add(task.page.url);
      retainedTaskCount += 1;
    } catch (error) {
      const taskId = fileName.replace(/\.json$/u, "");
      if (taskId) {
        invalidatedTaskIds.push(taskId);
      }
      await removePendingTaskBundle(paths, filePath, taskId);
      logger.warn(
        `Removed unreadable pending task ${filePath}: ${String(error)}`,
      );
    }
  }

  return {
    retainedPageUrls,
    retainedTaskCount,
    invalidatedTaskIds,
  };
}

export function createTaskId(pageUrl: string): string {
  return `task_${hashString(pageUrl).slice(0, 10)}`;
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
