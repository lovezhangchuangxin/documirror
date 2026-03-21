import pLimit from "p-limit";
import { join } from "pathe";

import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { resolveAiAuthToken } from "../../ai-config";
import { getRepoPaths } from "../../repo-paths";
import { loadConfig, loadSegments } from "../../storage";
import type {
  RunSummary,
  RunTranslationsOptions,
  RunTranslationsProgressEvent,
} from "../../types";
import { createRunDebugEmitter, formatRunDuration } from "../logging";
import {
  getRunFailureReportPath,
  toRepoRelativePath,
} from "../infra/task-repository";
import { isAbortLikeError, throwIfAborted } from "../runtime-utils";
import { syncTaskManifest } from "../services/task-manifest";
import { runSingleTask } from "../services/task-runner";

export async function runTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
  onProgress?: (event: RunTranslationsProgressEvent) => void,
  signal?: AbortSignal,
  options: RunTranslationsOptions = {},
): Promise<RunSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const emitDebug = createRunDebugEmitter(options.onDebug);
  emitDebug(
    `loaded AI config: ${config.ai.llmProvider}/${config.ai.modelName} via ${config.ai.baseUrl} (concurrency ${config.ai.concurrency}, timeout ${formatRunDuration(config.ai.requestTimeoutMs)}, max attempts ${config.ai.maxAttemptsPerTask})`,
  );
  const authToken = await resolveAiAuthToken(repoDir, config.ai);
  emitDebug("resolved API auth token");
  const segmentIndex = new Map(
    (await loadSegments(paths)).map((segment) => [segment.segmentId, segment]),
  );
  emitDebug(`loaded ${segmentIndex.size} extracted segments`);
  const manifest = await syncTaskManifest(
    repoDir,
    paths,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  const pendingTasks = manifest.tasks.filter(
    (task) => task.status === "pending",
  );
  const total = pendingTasks.length;
  emitDebug(`task manifest synced; ${total} pending task(s) ready to run`);
  let completed = 0;
  let successCount = 0;
  let failureCount = 0;

  onProgress?.({
    type: "queued",
    total,
    concurrency: config.ai.concurrency,
    provider: config.ai.llmProvider,
    model: config.ai.modelName,
    requestTimeoutMs: config.ai.requestTimeoutMs,
  });

  if (total === 0) {
    return {
      totalTasks: 0,
      completedTasks: 0,
      successCount: 0,
      failureCount: 0,
      skippedCount: 0,
      reportDir: toRepoRelativePath(
        repoDir,
        join(paths.reportsDir, "translation-run"),
      ),
    };
  }

  const limit = pLimit(config.ai.concurrency);
  await Promise.all(
    pendingTasks.map((entry) =>
      limit(async () => {
        throwIfAborted(signal);
        onProgress?.({
          type: "started",
          taskId: entry.taskId,
          completed,
          total,
        });

        try {
          await runSingleTask({
            repoDir,
            paths,
            taskId: entry.taskId,
            authToken,
            config,
            segmentIndex,
            logger,
            signal,
            onProgress,
            onDebug: emitDebug,
            getSnapshot: () => ({
              completed,
              successCount,
              failureCount,
              total,
            }),
          });
          completed += 1;
          successCount += 1;
          onProgress?.({
            type: "completed",
            taskId: entry.taskId,
            completed,
            total,
            successCount,
            failureCount,
          });
        } catch (error) {
          if (isAbortLikeError(error, signal)) {
            throw error;
          }
          completed += 1;
          failureCount += 1;
          const reportPath = getRunFailureReportPath(paths, entry.taskId);
          emitDebug(
            `${entry.taskId}: failed after all attempts; report written to ${toRepoRelativePath(repoDir, reportPath)}`,
          );
          onProgress?.({
            type: "failed",
            taskId: entry.taskId,
            completed,
            total,
            successCount,
            failureCount,
            error: error instanceof Error ? error.message : String(error),
            reportPath: toRepoRelativePath(repoDir, reportPath),
          });
        }
      }),
    ),
  );

  await syncTaskManifest(
    repoDir,
    paths,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );

  return {
    totalTasks: total,
    completedTasks: completed,
    successCount,
    failureCount,
    skippedCount: 0,
    reportDir: toRepoRelativePath(
      repoDir,
      join(paths.reportsDir, "translation-run"),
    ),
  };
}
