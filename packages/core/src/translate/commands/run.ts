import { join } from "pathe";

import type { Logger } from "@documirror/shared";
import { createTimestamp, defaultLogger } from "@documirror/shared";

import { resolveAiAuthToken } from "../../ai-config";
import { getRepoPaths } from "../../repo-paths";
import { loadConfig, loadSegments } from "../../storage";
import type {
  RunSummary,
  RunTranslationsOptions,
  RunTranslationsProgressEvent,
} from "../../types";
import { createRunDebugEmitter, formatRunDuration } from "../logging";
import { writeRunFailureReport } from "../infra/reports";
import {
  getRunFailureReportPath,
  toRepoRelativePath,
} from "../infra/task-repository";
import { isAbortLikeError, throwIfAborted } from "../runtime-utils";
import { syncTaskManifest } from "../services/task-manifest";
import {
  finalizeTaskRunSession,
  prepareTaskRunSession,
  runNextPreparedTaskChunk,
} from "../services/task-runner";
import {
  runWithCoordinator,
  type CoordinatorPage,
} from "../services/run-coordinator";

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

  const emitTaskFailure = async (
    taskId: string,
    error: unknown,
    session?: Awaited<ReturnType<typeof prepareTaskRunSession>>,
  ) => {
    completed += 1;
    failureCount += 1;
    const reportPath = getRunFailureReportPath(paths, taskId);
    const message = error instanceof Error ? error.message : String(error);
    const firstChunk = session?.failedChunkReports[0];

    await writeRunFailureReport(paths, {
      schemaVersion: session?.failedChunkReports.length ? 2 : 1,
      taskId,
      failedAt: createTimestamp(),
      attemptCount: session?.failedChunkReports.length
        ? Math.max(
            ...session.failedChunkReports.map((chunk) => chunk.attemptCount),
          )
        : config.ai.maxAttemptsPerTask,
      chunk: firstChunk
        ? {
            chunkId: firstChunk.chunkId,
            chunkIndex: firstChunk.chunkIndex,
            chunkCount: firstChunk.chunkCount,
            itemStart: firstChunk.itemStart,
            itemEnd: firstChunk.itemEnd,
            headingText: firstChunk.headingText,
          }
        : undefined,
      resultPreview: firstChunk?.resultPreview,
      errors: firstChunk?.errors ?? [],
      message,
      chunks: session?.failedChunkReports.length
        ? session.failedChunkReports
        : undefined,
    });

    emitDebug(
      `${taskId}: failed after all attempts; report written to ${toRepoRelativePath(repoDir, reportPath)}`,
    );
    onProgress?.({
      type: "failed",
      taskId,
      completed,
      total,
      successCount,
      failureCount,
      error: message,
      reportPath: toRepoRelativePath(repoDir, reportPath),
    });
  };

  const preparedPages: CoordinatorPage[] = [];

  for (const entry of pendingTasks) {
    throwIfAborted(signal);

    try {
      const session = await prepareTaskRunSession({
        paths,
        taskId: entry.taskId,
        config,
        segmentIndex,
        onDebug: emitDebug,
      });
      let started = false;
      let failedError: Error | undefined;

      preparedPages.push({
        taskId: entry.taskId,
        hasPendingChunks() {
          return !failedError && session.pendingChunkIndices.length > 0;
        },
        async startNextChunk() {
          throwIfAborted(signal);
          if (!started) {
            started = true;
            onProgress?.({
              type: "started",
              taskId: entry.taskId,
              completed,
              total,
            });
          }

          try {
            await runNextPreparedTaskChunk({
              session,
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
          } catch (error) {
            if (isAbortLikeError(error, signal)) {
              throw error;
            }

            failedError =
              error instanceof Error ? error : new Error(String(error));
            session.pendingChunkIndices.length = 0;
          }
        },
        onChunkSettled() {},
        async finalize() {
          if (failedError) {
            await emitTaskFailure(entry.taskId, failedError, session);
            return;
          }

          try {
            await finalizeTaskRunSession({
              repoDir,
              paths,
              session,
              config,
              segmentIndex,
              onDebug: emitDebug,
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
            await emitTaskFailure(entry.taskId, error, session);
          }
        },
      });
    } catch (error) {
      if (isAbortLikeError(error, signal)) {
        throw error;
      }
      await emitTaskFailure(entry.taskId, error);
    }
  }

  await runWithCoordinator({
    concurrency: config.ai.concurrency,
    pages: preparedPages,
  });

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
