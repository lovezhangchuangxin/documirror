import fs from "fs-extra";

import { translateTaskWithOpenAi } from "@documirror/adapters-openai";
import {
  createChunkTaskArtifacts,
  mergeChunkDrafts,
  planPageChunks,
  type PlannedPageChunk,
} from "../../page-chunking";
import type { loadConfig } from "../../storage";
import { readJson, writeJson } from "../../storage";
import type {
  Logger,
  TranslationDraftResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
  TranslationVerificationIssue,
} from "@documirror/shared";
import { createTimestamp } from "@documirror/shared";

import type { RepoPaths } from "../../types";
import type {
  RunTaskSnapshot,
  RunTaskViewResult,
  SegmentIndex,
} from "../internal-types";
import {
  describeTaskView,
  formatChunkRange,
  formatIssueSummary,
  formatRunDuration,
} from "../logging";
import {
  writeRunFailureReport,
  writeVerificationReport,
} from "../infra/reports";
import {
  getDoneResultPath,
  getPendingTaskPath,
  getRunFailureReportPath,
  loadRequiredTaskMapping,
  toRepoRelativePath,
} from "../infra/task-repository";
import {
  createIssuesFromUnknownError,
  validateTaskFreshness,
  validateTaskStructure,
  verifyCandidateResult,
} from "../domain/verification";
import { isAbortLikeError, throwIfAborted } from "../runtime-utils";
import type { RunTranslationsProgressEvent } from "../../types";
import { parseTaskFile } from "@documirror/adapters-filequeue";

export async function runSingleTask(options: {
  repoDir: string;
  paths: RepoPaths;
  taskId: string;
  authToken: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: SegmentIndex;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: RunTranslationsProgressEvent) => void;
  onDebug?: (message: string) => void;
  getSnapshot: () => RunTaskSnapshot;
}): Promise<void> {
  const {
    repoDir,
    paths,
    taskId,
    authToken,
    config,
    segmentIndex,
    logger,
    signal,
    onProgress,
    onDebug,
    getSnapshot,
  } = options;
  onDebug?.(`${taskId}: loading task bundle`);
  const task = parseTaskFile(
    await readJson(getPendingTaskPath(paths, taskId), {}),
  );
  const mapping = await loadRequiredTaskMapping(paths.taskMappingsDir, taskId);
  onDebug?.(
    `${taskId}: loaded ${task.content.length} content item(s); validating freshness`,
  );
  const freshnessIssues = [
    ...validateTaskStructure(task),
    ...validateTaskFreshness(task, mapping, segmentIndex),
  ];
  if (freshnessIssues.length > 0) {
    await writeRunFailureReport(
      paths,
      taskId,
      config.ai.maxAttemptsPerTask,
      freshnessIssues,
      undefined,
      freshnessIssues[0]?.message ?? `Task ${taskId} is stale`,
    );
    onDebug?.(
      `${taskId}: freshness validation failed before translation: ${formatIssueSummary(freshnessIssues[0])}`,
    );
    throw new Error(freshnessIssues[0]?.message ?? `Task ${taskId} is stale`);
  }

  const chunkPlan = planPageChunks({
    task,
    mapping,
    segmentIndex,
    chunking: config.ai.chunking,
  });
  if (chunkPlan.chunks.length > 1) {
    onDebug?.(
      `${taskId}: split ${task.content.length} item(s) into ${chunkPlan.chunks.length} chunk(s): ${chunkPlan.chunks
        .map((chunk) =>
          formatChunkRange(chunk.headingText, chunk.itemStart, chunk.itemEnd),
        )
        .join("; ")}`,
    );
  }

  const chunkDrafts: Array<{
    chunk: PlannedPageChunk;
    draft: TranslationDraftResultFile;
    originalIds: string[];
  }> = [];

  for (const chunk of chunkPlan.chunks) {
    const artifacts = createChunkTaskArtifacts(task, mapping, chunk);
    const result = await runTaskView({
      repoDir,
      paths,
      taskId,
      task: artifacts.task,
      mapping: artifacts.mapping,
      authToken,
      config,
      segmentIndex,
      logger,
      signal,
      onProgress,
      onDebug,
      getSnapshot,
      chunk: chunkPlan.chunks.length > 1 ? chunk : undefined,
    });
    chunkDrafts.push({
      chunk,
      draft: result.draft,
      originalIds: artifacts.originalIds,
    });
  }

  const finalDraft =
    chunkDrafts.length === 1 && chunkDrafts[0]?.chunk.isWholeTask
      ? chunkDrafts[0].draft
      : mergeChunkDrafts({
          taskId,
          chunkDrafts,
        });
  const finalVerification = verifyCandidateResult(
    task,
    mapping,
    segmentIndex,
    finalDraft,
  );
  if (!finalVerification.ok) {
    await writeRunFailureReport(
      paths,
      taskId,
      config.ai.maxAttemptsPerTask,
      finalVerification.errors,
      JSON.stringify(finalDraft, null, 2),
      finalVerification.errors[0]?.message ??
        `Merged translation failed verification for ${taskId}`,
    );
    throw new Error(
      finalVerification.errors[0]?.message ??
        `Merged translation failed verification for ${taskId}`,
    );
  }

  const resultPath = getDoneResultPath(paths, taskId);
  onDebug?.(`${taskId}: passed validation; writing merged result`);
  const result = {
    schemaVersion: 2 as const,
    taskId,
    provider: config.ai.llmProvider,
    model: config.ai.modelName,
    completedAt: createTimestamp(),
    translations: finalDraft.translations,
  };
  await writeJson(resultPath, result);
  const resultBody = await fs.readFile(resultPath, "utf8");
  await writeVerificationReport(
    repoDir,
    paths,
    taskId,
    resultPath,
    resultBody,
    finalVerification,
  );
  await fs.remove(getRunFailureReportPath(paths, taskId));
  onDebug?.(
    `${taskId}: wrote done result and verification report to ${toRepoRelativePath(repoDir, resultPath)}`,
  );
}

async function runTaskView(options: {
  repoDir: string;
  paths: RepoPaths;
  taskId: string;
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
  authToken: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: SegmentIndex;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: RunTranslationsProgressEvent) => void;
  onDebug?: (message: string) => void;
  getSnapshot: () => RunTaskSnapshot;
  chunk?: PlannedPageChunk;
}): Promise<RunTaskViewResult> {
  const {
    paths,
    taskId,
    task,
    mapping,
    authToken,
    config,
    segmentIndex,
    logger,
    signal,
    onProgress,
    onDebug,
    getSnapshot,
    chunk,
  } = options;
  const label = describeTaskView(taskId, chunk);
  const freshnessIssues = [
    ...validateTaskStructure(task),
    ...validateTaskFreshness(task, mapping, segmentIndex),
  ];
  if (freshnessIssues.length > 0) {
    await writeRunFailureReport(
      paths,
      taskId,
      config.ai.maxAttemptsPerTask,
      freshnessIssues,
      undefined,
      freshnessIssues[0]?.message ?? `Task ${taskId} is stale`,
      chunk,
    );
    onDebug?.(
      `${label}: freshness validation failed before translation: ${formatIssueSummary(freshnessIssues[0])}`,
    );
    throw new Error(freshnessIssues[0]?.message ?? `Task ${taskId} is stale`);
  }

  let previousResponse: string | undefined;
  let lastIssues: TranslationVerificationIssue[] = [];

  for (let attempt = 1; attempt <= config.ai.maxAttemptsPerTask; attempt += 1) {
    throwIfAborted(signal);
    const snapshot = getSnapshot();
    onProgress?.({
      type: "attempt",
      taskId,
      attempt,
      maxAttempts: config.ai.maxAttemptsPerTask,
      completed: snapshot.completed,
      total: snapshot.total,
      chunk: chunk
        ? {
            chunkIndex: chunk.chunkIndex + 1,
            chunkCount: chunk.chunkCount,
            itemStart: chunk.itemStart,
            itemEnd: chunk.itemEnd,
            headingText: chunk.headingText,
          }
        : undefined,
    });
    onDebug?.(
      `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} starting`,
    );

    try {
      const requestStartedAt = Date.now();
      onDebug?.(
        `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} sending request to ${config.ai.baseUrl}`,
      );
      const translated = await translateTaskWithOpenAi({
        config: config.ai,
        authToken,
        signal,
        task,
        previousResponse,
        verificationIssues: lastIssues,
        chunkContext: chunk
          ? {
              chunkIndex: chunk.chunkIndex + 1,
              chunkCount: chunk.chunkCount,
              itemStart: chunk.itemStart,
              itemEnd: chunk.itemEnd,
              headingText: chunk.headingText,
            }
          : undefined,
        onDebug(message) {
          onDebug?.(`${label}: ${message}`);
        },
      });
      onDebug?.(
        `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} received response after ${formatRunDuration(Date.now() - requestStartedAt)}`,
      );
      previousResponse = JSON.stringify(translated.draft, null, 2);

      const verification = verifyCandidateResult(
        task,
        mapping,
        segmentIndex,
        translated.draft,
      );
      if (!verification.ok) {
        lastIssues = verification.errors;
        logger.warn(
          `${label} failed validation on attempt ${attempt}: ${verification.errors[0]?.message ?? "unknown error"}`,
        );
        onDebug?.(
          `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} validation failed: ${formatIssueSummary(verification.errors[0])}; retrying`,
        );
        continue;
      }

      onProgress?.({
        type: "attemptCompleted",
        taskId,
        completed: snapshot.completed,
        total: snapshot.total,
        chunk: chunk
          ? {
              chunkIndex: chunk.chunkIndex + 1,
              chunkCount: chunk.chunkCount,
              itemStart: chunk.itemStart,
              itemEnd: chunk.itemEnd,
              headingText: chunk.headingText,
            }
          : undefined,
      });

      return {
        draft: translated.draft,
        verification,
      };
    } catch (error) {
      if (isAbortLikeError(error, signal)) {
        onDebug?.(
          `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} cancelled by user`,
        );
        throw error;
      }
      const issues = createIssuesFromUnknownError(error, "$");
      lastIssues = issues;
      onDebug?.(
        `${label}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await writeRunFailureReport(
        paths,
        taskId,
        attempt,
        issues,
        previousResponse,
        error instanceof Error ? error.message : String(error),
        chunk,
      );
      onDebug?.(
        `${label}: wrote failure report for attempt ${attempt}/${config.ai.maxAttemptsPerTask}`,
      );
      if (attempt === config.ai.maxAttemptsPerTask) {
        throw error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  await writeRunFailureReport(
    paths,
    taskId,
    config.ai.maxAttemptsPerTask,
    lastIssues,
    previousResponse,
    `Translation failed for ${taskId}`,
    chunk,
  );
  onDebug?.(`${label}: exhausted all attempts without a valid result`);
  throw new Error(`Translation failed for ${taskId}`);
}
