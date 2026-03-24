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
  TranslationTaskFile,
  TranslationTaskMappingFile,
  TranslationVerificationIssue,
} from "@documirror/shared";
import { createTimestamp } from "@documirror/shared";

import type { RepoPaths } from "../../types";
import type {
  PreparedTaskRunSession,
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
import { writeVerificationReport } from "../infra/reports";
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
  const session = await prepareTaskRunSession({
    paths,
    taskId,
    config,
    segmentIndex,
    onDebug,
  });

  while (session.pendingChunkIndices.length > 0) {
    await runNextPreparedTaskChunk({
      session,
      authToken,
      config,
      segmentIndex,
      logger,
      signal,
      onProgress,
      onDebug,
      getSnapshot,
    });
  }

  await finalizeTaskRunSession({
    repoDir,
    paths,
    session,
    config,
    segmentIndex,
    onDebug,
  });
}

export async function prepareTaskRunSession(options: {
  paths: RepoPaths;
  taskId: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: SegmentIndex;
  onDebug?: (message: string) => void;
}): Promise<PreparedTaskRunSession> {
  const { paths, taskId, config, segmentIndex, onDebug } = options;
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

  return {
    taskId,
    task,
    mapping,
    chunkPlan,
    pendingChunkIndices: chunkPlan.chunks.map((_, index) => index),
    chunkDrafts: [],
    failedChunkReports: [],
  };
}

export async function runNextPreparedTaskChunk(options: {
  session: PreparedTaskRunSession;
  authToken: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: SegmentIndex;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: RunTranslationsProgressEvent) => void;
  onDebug?: (message: string) => void;
  getSnapshot: () => RunTaskSnapshot;
}): Promise<PlannedPageChunk | null> {
  const {
    session,
    authToken,
    config,
    segmentIndex,
    logger,
    signal,
    onProgress,
    onDebug,
    getSnapshot,
  } = options;
  const chunkIndex = session.pendingChunkIndices.shift();
  if (chunkIndex === undefined) {
    return null;
  }

  const chunk = session.chunkPlan.chunks[chunkIndex];
  if (!chunk) {
    throw new Error(
      `Chunk ${chunkIndex} is missing for prepared session ${session.taskId}`,
    );
  }
  const artifacts = createChunkTaskArtifacts(
    session.task,
    session.mapping,
    chunk,
  );
  try {
    const result = await runTaskView({
      taskId: session.taskId,
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
      chunk: session.chunkPlan.chunks.length > 1 ? chunk : undefined,
    });
    session.chunkDrafts.push({
      chunk,
      draft: result.draft,
      originalIds: artifacts.originalIds,
    });
  } catch (error) {
    session.failedChunkReports.push(
      toChunkFailureReport(
        chunk,
        toRunTaskViewFailure(
          error,
          config.ai.maxAttemptsPerTask,
          error instanceof Error ? error.message : String(error),
        ),
      ),
    );
    throw error;
  }

  return chunk;
}

export async function finalizeTaskRunSession(options: {
  repoDir: string;
  paths: RepoPaths;
  session: PreparedTaskRunSession;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: SegmentIndex;
  onDebug?: (message: string) => void;
}): Promise<void> {
  const { repoDir, paths, session, config, segmentIndex, onDebug } = options;
  const finalDraft =
    session.chunkDrafts.length === 1 &&
    session.chunkDrafts[0]?.chunk.isWholeTask
      ? session.chunkDrafts[0].draft
      : mergeChunkDrafts({
          taskId: session.taskId,
          chunkDrafts: session.chunkDrafts,
        });
  const finalVerification = verifyCandidateResult(
    session.task,
    session.mapping,
    segmentIndex,
    finalDraft,
  );
  if (!finalVerification.ok) {
    throw new Error(
      finalVerification.errors[0]?.message ??
        `Merged translation failed verification for ${session.taskId}`,
    );
  }

  const resultPath = getDoneResultPath(paths, session.taskId);
  onDebug?.(`${session.taskId}: passed validation; writing merged result`);
  const result = {
    schemaVersion: 2 as const,
    taskId: session.taskId,
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
    session.taskId,
    resultPath,
    resultBody,
    finalVerification,
  );
  await fs.remove(getRunFailureReportPath(paths, session.taskId));
  onDebug?.(
    `${session.taskId}: wrote done result and verification report to ${toRepoRelativePath(repoDir, resultPath)}`,
  );
}

async function runTaskView(options: {
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
    onDebug?.(
      `${label}: freshness validation failed before translation: ${formatIssueSummary(freshnessIssues[0])}`,
    );
    throw createRunTaskViewFailureError({
      attemptCount: config.ai.maxAttemptsPerTask,
      errors: freshnessIssues,
      message: freshnessIssues[0]?.message ?? `Task ${taskId} is stale`,
      chunk,
    });
  }

  let previousResponse: string | undefined;
  let lastIssues: TranslationVerificationIssue[] = [];

  for (let attempt = 1; attempt <= config.ai.maxAttemptsPerTask; attempt += 1) {
    throwIfAborted(signal);
    const snapshot = getSnapshot();
    onProgress?.({
      type: "attempt",
      taskId,
      pageTaskId: taskId,
      activityId: chunk?.chunkId ?? taskId,
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
        pageTaskId: taskId,
        activityId: chunk?.chunkId ?? taskId,
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
      if (attempt === config.ai.maxAttemptsPerTask) {
        throw createRunTaskViewFailureError({
          attemptCount: attempt,
          errors: issues,
          resultPreview: previousResponse,
          message: error instanceof Error ? error.message : String(error),
          chunk,
        });
      }
    }
  }

  onDebug?.(`${label}: exhausted all attempts without a valid result`);
  throw createRunTaskViewFailureError({
    attemptCount: config.ai.maxAttemptsPerTask,
    errors: lastIssues,
    resultPreview: previousResponse,
    message: `Translation failed for ${taskId}`,
    chunk,
  });
}

type RunTaskViewFailure = {
  attemptCount: number;
  errors: TranslationVerificationIssue[];
  resultPreview?: string;
  message: string;
  chunk?: PlannedPageChunk;
};

function createRunTaskViewFailureError(
  failure: RunTaskViewFailure,
): Error & { failure: RunTaskViewFailure } {
  return Object.assign(new Error(failure.message), {
    failure,
  });
}

function toRunTaskViewFailure(
  error: unknown,
  attemptCount: number,
  fallbackMessage: string,
): RunTaskViewFailure {
  if (
    error &&
    typeof error === "object" &&
    "failure" in error &&
    (error as { failure?: RunTaskViewFailure }).failure
  ) {
    return (error as { failure: RunTaskViewFailure }).failure;
  }

  return {
    attemptCount,
    errors: createIssuesFromUnknownError(error, "$"),
    message: fallbackMessage,
  };
}

function toChunkFailureReport(
  chunk: PlannedPageChunk,
  failure: RunTaskViewFailure,
): PreparedTaskRunSession["failedChunkReports"][number] {
  return {
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex + 1,
    chunkCount: chunk.chunkCount,
    itemStart: chunk.itemStart,
    itemEnd: chunk.itemEnd,
    headingText: chunk.headingText,
    attemptCount: failure.attemptCount,
    resultPreview: failure.resultPreview,
    errors: failure.errors,
    message: failure.message,
  };
}
