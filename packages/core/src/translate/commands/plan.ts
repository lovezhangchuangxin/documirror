import { createTaskBundle } from "@documirror/adapters-filequeue";
import { join } from "pathe";
import {
  carryForwardTranslations,
  findPendingSegments,
  markStaleTranslations,
} from "@documirror/i18n";
import type { JsonValue, Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "../../repo-paths";
import {
  loadConfig,
  loadManifest,
  loadSegments,
  loadTranslations,
  readJson,
  writeJson,
  writeJsonl,
} from "../../storage";
import type { PlanSummary } from "../../types";
import { getTaskMappingPath } from "../infra/task-repository";
import {
  buildPlannedPageTasks,
  createTaskId,
  retainPendingTasks,
} from "../services/task-planner";
import { syncTaskManifest } from "../services/task-manifest";

export async function planTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<PlanSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const currentTranslations = await loadTranslations(paths);
  const translations = carryForwardTranslations(
    segments,
    markStaleTranslations(segments, currentTranslations),
  );
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
  const { retainedPageUrls, retainedTaskCount, invalidatedTaskIds } =
    await retainPendingTasks(
      paths,
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
    const taskId = createTaskId(plannedPage.pageUrl);
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
  await syncTaskManifest(
    repoDir,
    paths,
    config.sourceUrl,
    config.targetLocale,
    logger,
    invalidatedTaskIds,
  );
  logger.info(
    `Planned ${pendingSegments.length} segments across ${taskCount} pending page tasks (${retainedTaskCount} retained, ${createdTaskCount} created)`,
  );
  return {
    taskCount,
    segmentCount: pendingSegments.length,
  };
}
