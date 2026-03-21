import fs from "fs-extra";
import pLimit from "p-limit";
import { basename } from "pathe";

import type { Logger, TranslationTaskManifest } from "@documirror/shared";
import {
  createTimestamp,
  translationTaskManifestEntrySchema,
  translationTaskManifestSchema,
} from "@documirror/shared";

import type { RepoPaths } from "../../types";
import { writeJson } from "../../storage";
import {
  createTaskManifestSummary,
  compareManifestEntries,
  renderTaskQueueBoard,
  buildInvalidManifestEntry,
} from "../domain/task-summary";
import { loadRunFailureReport, loadVerificationReport } from "../infra/reports";
import {
  getAppliedResultPath,
  getDoneResultPath,
  getPendingTaskPath,
  getRunFailureReportPath,
  getTaskIdFromPath,
  getVerificationReportPath,
  listTaskFiles,
  loadResultFile,
  loadTaskManifest,
  toRepoRelativePath,
} from "../infra/task-repository";
import { resolveFileIoConcurrency } from "../runtime-utils";
import { readJson } from "../../storage";
import { parseTaskFile } from "@documirror/adapters-filequeue";

export async function syncTaskManifest(
  repoDir: string,
  paths: RepoPaths,
  sourceUrl: string,
  targetLocale: string,
  logger: Logger,
  invalidatedTaskIds: string[] = [],
): Promise<TranslationTaskManifest> {
  const previousManifest = await loadTaskManifest(
    paths.taskManifestPath,
    sourceUrl,
    targetLocale,
    logger,
  );
  const previousEntryByTaskId = new Map(
    previousManifest.tasks.map((task) => [task.taskId, task]),
  );
  const entriesById = new Map<
    string,
    TranslationTaskManifest["tasks"][number]
  >();
  const loadLimit = pLimit(resolveFileIoConcurrency());

  const pendingTaskFiles = await listTaskFiles(paths.tasksPendingDir, "*.json");
  const pendingEntries = await Promise.all(
    pendingTaskFiles.map((taskFilePath) =>
      loadLimit(async () => {
        try {
          return {
            ok: true as const,
            entry: await buildPendingTaskManifestEntry(
              repoDir,
              paths,
              taskFilePath,
              logger,
            ),
          };
        } catch (error) {
          const taskId = getTaskIdFromPath(taskFilePath);
          return {
            ok: false as const,
            error,
            taskFilePath,
            taskId,
          };
        }
      }),
    ),
  );
  for (const result of pendingEntries) {
    if (result.ok) {
      entriesById.set(result.entry.taskId, result.entry);
      continue;
    }

    if (result.taskId) {
      entriesById.set(
        result.taskId,
        buildInvalidManifestEntry({
          taskId: result.taskId,
          taskFile: toRepoRelativePath(repoDir, result.taskFilePath),
          previousEntry: previousEntryByTaskId.get(result.taskId),
        }),
      );
    }
    logger.warn(
      `Skipping unreadable task manifest entry ${result.taskFilePath}: ${String(result.error)}`,
    );
  }

  const appliedTaskFiles = await listTaskFiles(
    paths.tasksAppliedDir,
    "*.task.json",
  );
  const appliedEntries = await Promise.all(
    appliedTaskFiles.map((taskFilePath) =>
      loadLimit(async () => {
        try {
          return {
            ok: true as const,
            entry: await buildAppliedTaskManifestEntry(
              repoDir,
              paths,
              taskFilePath,
              logger,
            ),
          };
        } catch (error) {
          const taskId = basename(taskFilePath, ".task.json");
          return {
            ok: false as const,
            error,
            taskFilePath,
            taskId,
          };
        }
      }),
    ),
  );
  for (const result of appliedEntries) {
    if (result.ok) {
      if (!entriesById.has(result.entry.taskId)) {
        entriesById.set(result.entry.taskId, result.entry);
      }
      continue;
    }

    if (result.taskId && !entriesById.has(result.taskId)) {
      entriesById.set(
        result.taskId,
        buildInvalidManifestEntry({
          taskId: result.taskId,
          taskFile: toRepoRelativePath(repoDir, result.taskFilePath),
          doneResultFile: toRepoRelativePath(
            repoDir,
            getAppliedResultPath(paths.tasksAppliedDir, result.taskId),
          ),
          previousEntry: previousEntryByTaskId.get(result.taskId),
        }),
      );
    }
    logger.warn(
      `Skipping unreadable applied task manifest entry ${result.taskFilePath}: ${String(result.error)}`,
    );
  }

  for (const taskId of invalidatedTaskIds) {
    if (entriesById.has(taskId)) {
      continue;
    }

    const previousEntry = previousEntryByTaskId.get(taskId);
    entriesById.set(
      taskId,
      buildInvalidManifestEntry({
        taskId,
        taskFile:
          previousEntry?.taskFile ??
          toRepoRelativePath(repoDir, getPendingTaskPath(paths, taskId)),
        doneResultFile: previousEntry?.doneResultFile,
        previousEntry,
      }),
    );
  }

  const tasks = [...entriesById.values()].sort(compareManifestEntries);
  const manifest = translationTaskManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: createTimestamp(),
    sourceUrl,
    targetLocale,
    summary: createTaskManifestSummary(tasks),
    tasks,
  });

  await writeJson(paths.taskManifestPath, manifest);
  await fs.writeFile(
    paths.taskQueuePath,
    renderTaskQueueBoard(manifest),
    "utf8",
  );
  return manifest;
}

async function buildPendingTaskManifestEntry(
  repoDir: string,
  paths: RepoPaths,
  taskFilePath: string,
  logger: Logger,
) {
  const task = parseTaskFile(await readJson(taskFilePath, {}));
  const doneResultPath = getDoneResultPath(paths, task.taskId);
  const report = await loadVerificationReport(
    getVerificationReportPath(paths, task.taskId),
    logger,
  );
  const runReport = await loadRunFailureReport(
    getRunFailureReportPath(paths, task.taskId),
  );
  const doneResult = await loadResultFile(doneResultPath, logger);
  const hasDoneResult = await fs.pathExists(doneResultPath);

  if (hasDoneResult && !doneResult) {
    return buildInvalidManifestEntry({
      taskId: task.taskId,
      taskFile: toRepoRelativePath(repoDir, taskFilePath),
      doneResultFile: toRepoRelativePath(repoDir, doneResultPath),
      page: task.page,
      contentCount: task.content.length,
    });
  }

  return translationTaskManifestEntrySchema.parse({
    taskId: task.taskId,
    page: task.page,
    status: hasDoneResult ? "done" : "pending",
    contentCount: task.content.length,
    taskFile: toRepoRelativePath(repoDir, taskFilePath),
    doneResultFile: hasDoneResult
      ? toRepoRelativePath(repoDir, doneResultPath)
      : undefined,
    completedAt: doneResult?.completedAt,
    provider: doneResult?.provider,
    model: doneResult?.model,
    lastVerifiedAt: report?.checkedAt,
    lastVerifyStatus: report ? (report.ok ? "pass" : "fail") : undefined,
    lastVerifyErrorCount: report?.errorCount,
    lastRunAt: runReport?.failedAt,
    lastRunStatus: runReport ? "fail" : undefined,
    lastRunError: runReport?.message,
  });
}

async function buildAppliedTaskManifestEntry(
  repoDir: string,
  paths: RepoPaths,
  taskFilePath: string,
  logger: Logger,
) {
  const task = parseTaskFile(await readJson(taskFilePath, {}));
  const taskId = basename(taskFilePath, ".task.json");
  const resultPath = getAppliedResultPath(paths.tasksAppliedDir, taskId);
  const result = await loadResultFile(resultPath, logger);
  const report = await loadVerificationReport(
    getVerificationReportPath(paths, taskId),
    logger,
  );
  const runReport = await loadRunFailureReport(
    getRunFailureReportPath(paths, taskId),
  );

  if (!(await fs.pathExists(resultPath)) || !result) {
    return buildInvalidManifestEntry({
      taskId,
      taskFile: toRepoRelativePath(repoDir, taskFilePath),
      doneResultFile: toRepoRelativePath(repoDir, resultPath),
      page: task.page,
      contentCount: task.content.length,
    });
  }

  return translationTaskManifestEntrySchema.parse({
    taskId,
    page: task.page,
    status: "applied",
    contentCount: task.content.length,
    taskFile: toRepoRelativePath(repoDir, taskFilePath),
    doneResultFile: toRepoRelativePath(repoDir, resultPath),
    completedAt: result.completedAt,
    provider: result.provider,
    model: result.model,
    lastVerifiedAt: report?.checkedAt,
    lastVerifyStatus: report ? (report.ok ? "pass" : "fail") : undefined,
    lastVerifyErrorCount: report?.errorCount,
    lastRunAt: runReport?.failedAt,
    lastRunStatus: runReport ? "fail" : undefined,
    lastRunError: runReport?.message,
  });
}
