import fg from "fast-glob";
import fs from "fs-extra";
import pLimit from "p-limit";
import { basename, join, relative } from "pathe";
import { ZodError } from "zod";

import { translateTaskWithOpenAi } from "@documirror/adapters-openai";
import {
  createTaskBundle,
  parseResultFile,
  parseTaskFile,
  parseTaskMappingFile,
} from "@documirror/adapters-filequeue";
import {
  carryForwardTranslations,
  findPendingSegments,
  markStaleTranslations,
} from "@documirror/i18n";
import {
  buildTranslationTaskUnits,
  type TranslationTaskUnit,
} from "@documirror/parser";
import type {
  JsonValue,
  Logger,
  Manifest,
  SegmentRecord,
  TranslationDraftResultFile,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskManifest,
  TranslationTaskManifestEntry,
  TranslationTaskMappingEntry,
  TranslationTaskMappingFile,
  TranslationVerificationIssue,
  TranslationVerificationReport,
} from "@documirror/shared";
import {
  createTimestamp,
  defaultLogger,
  extractPlaceholderTokens,
  hashString,
  normalizeText,
  parseInlineCodeSpans,
  replacePlaceholderTokens,
  translationTaskManifestEntrySchema,
  translationTaskManifestSchema,
  translationVerificationReportSchema,
} from "@documirror/shared";

import { resolveAiAuthToken } from "./ai-config";
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
import type {
  ApplySummary,
  PlanSummary,
  RunSummary,
  RunTranslationsOptions,
  RunTranslationsProgressEvent,
  VerifySummary,
} from "./types";

const VERIFY_REPORT_DIR = "translation-verify";
const RUN_REPORT_DIR = "translation-run";
const TASK_STATUS_ORDER = {
  pending: 0,
  done: 1,
  applied: 2,
  invalid: 3,
} as const;

type PlannedPageTask = {
  pageUrl: string;
  units: TranslationTaskUnit[];
};

type RetainPendingTasksResult = {
  retainedPageUrls: Set<string>;
  retainedTaskCount: number;
  invalidatedTaskIds: string[];
};

type RunFailureReport = {
  schemaVersion: 1;
  taskId: string;
  failedAt: string;
  attemptCount: number;
  resultPreview?: string;
  errors: TranslationVerificationIssue[];
  message: string;
};

type CandidateVerification = {
  ok: boolean;
  errors: TranslationVerificationIssue[];
  warnings: TranslationVerificationIssue[];
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

export async function refreshTranslationTaskManifest(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<TranslationTaskManifest> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  return syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
}

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
        join(paths.reportsDir, RUN_REPORT_DIR),
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
      join(paths.reportsDir, RUN_REPORT_DIR),
    ),
  };
}

export async function verifyTranslationTask(
  repoDir: string,
  taskId: string,
  options: {
    resultPath?: string;
  } = {},
  logger: Logger = defaultLogger,
): Promise<VerifySummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segmentIndex = new Map(
    (await loadSegments(paths)).map((segment) => [segment.segmentId, segment]),
  );
  const { task, mapping } = await loadTaskArtifacts(paths, taskId);
  const resultPath = options.resultPath ?? getDoneResultPath(paths, taskId);

  if (!(await fs.pathExists(resultPath))) {
    throw new Error(
      `Result file is missing: ${toRepoRelativePath(repoDir, resultPath)}`,
    );
  }

  const resultBody = await fs.readFile(resultPath, "utf8");
  let verification: CandidateVerification;
  try {
    const candidate = parseCandidateResult(resultBody);
    verification = verifyCandidateResult(
      task,
      mapping,
      segmentIndex,
      candidate,
    );
  } catch (error) {
    verification = {
      ok: false,
      errors: createIssuesFromUnknownError(error, "$"),
      warnings: [],
    };
  }
  const report = buildVerificationReport({
    repoDir,
    taskId,
    resultPath,
    resultBody,
    verification,
  });
  const reportPath = getVerificationReportPath(paths, taskId);
  await writeJson(reportPath, report);

  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    taskId,
    ok: report.ok,
    reportPath: toRepoRelativePath(repoDir, reportPath),
    errorCount: report.errorCount,
    warningCount: report.warningCount,
    errors: report.errors,
    warnings: report.warnings,
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

  for (const filePath of files.sort()) {
    let parsed: TranslationResultFile;
    try {
      parsed = parseResultFile(await readJson(filePath, {}));
    } catch (error) {
      logger.warn(
        `Skipping unreadable result file ${filePath}: ${String(error)}`,
      );
      continue;
    }

    const taskPath = getPendingTaskPath(paths, parsed.taskId);
    if (!(await fs.pathExists(taskPath))) {
      logger.warn(
        `Skipping result import for ${parsed.taskId} because its pending task file is missing`,
      );
      continue;
    }

    const task = parseTaskFile(await readJson(taskPath, {}));
    const mapping = await loadTaskMapping(paths.taskMappingsDir, parsed.taskId);
    if (!mapping) {
      logger.warn(
        `Skipping result import for ${parsed.taskId} because its task mapping is missing or unreadable`,
      );
      continue;
    }

    const issues = [
      ...validateTaskStructure(task),
      ...validateTaskFreshness(task, mapping, segmentIndex),
      ...validateTranslationsAgainstTask(task, mapping, parsed),
    ];
    if (issues.length > 0) {
      logger.warn(
        `Skipping result import for ${parsed.taskId} because verification failed`,
      );
      issues.forEach((issue) => {
        logger.warn(`[${issue.code}] ${issue.jsonPath}: ${issue.message}`);
      });
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
        provider: `${parsed.provider}/${parsed.model}`,
        completedAt: parsed.completedAt,
        filePath,
        segmentIndex,
        translationIndex,
        logger,
      });
      appliedSegments += appliedCount;
    }

    const archiveStamp = createArchiveStamp(parsed.completedAt);
    await archivePendingTaskFile(paths, parsed.taskId, archiveStamp);
    await archiveTaskMapping(parsed.taskId, paths, archiveStamp);
    await archiveDoneResultFile(paths, parsed.taskId, filePath, archiveStamp);
    appliedFiles += 1;
  }

  await writeJsonl(paths.translationsPath, [...translationIndex.values()]);
  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    appliedFiles,
    appliedSegments,
  };
}

async function runSingleTask(options: {
  repoDir: string;
  taskId: string;
  authToken: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  segmentIndex: Map<string, SegmentRecord>;
  logger: Logger;
  signal?: AbortSignal;
  onProgress?: (event: RunTranslationsProgressEvent) => void;
  onDebug?: (message: string) => void;
  getSnapshot: () => {
    completed: number;
    successCount: number;
    failureCount: number;
    total: number;
  };
}): Promise<void> {
  const {
    repoDir,
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
  const paths = getRepoPaths(repoDir);
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
    });
    onDebug?.(
      `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} starting`,
    );

    try {
      const requestStartedAt = Date.now();
      onDebug?.(
        `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} sending request to ${config.ai.baseUrl}`,
      );
      const translated = await translateTaskWithOpenAi({
        config: config.ai,
        authToken,
        signal,
        task,
        previousResponse,
        verificationIssues: lastIssues,
        onDebug(message) {
          onDebug?.(`${taskId}: ${message}`);
        },
      });
      onDebug?.(
        `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} received response after ${formatRunDuration(Date.now() - requestStartedAt)}`,
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
          `Task ${taskId} failed validation on attempt ${attempt}: ${verification.errors[0]?.message ?? "unknown error"}`,
        );
        onDebug?.(
          `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} validation failed: ${formatIssueSummary(verification.errors[0])}; retrying`,
        );
        continue;
      }

      const resultPath = getDoneResultPath(paths, taskId);
      onDebug?.(
        `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} passed validation; writing result`,
      );
      const result = {
        schemaVersion: 2 as const,
        taskId,
        provider: config.ai.llmProvider,
        model: config.ai.modelName,
        completedAt: createTimestamp(),
        translations: translated.draft.translations,
      };
      await writeJson(resultPath, result);
      const resultBody = await fs.readFile(resultPath, "utf8");
      const report = buildVerificationReport({
        repoDir,
        taskId,
        resultPath,
        resultBody,
        verification,
      });
      await writeJson(getVerificationReportPath(paths, taskId), report);
      await fs.remove(getRunFailureReportPath(paths, taskId));
      onDebug?.(
        `${taskId}: wrote done result and verification report to ${toRepoRelativePath(repoDir, resultPath)}`,
      );
      return;
    } catch (error) {
      if (isAbortLikeError(error, signal)) {
        onDebug?.(
          `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} cancelled by user`,
        );
        throw error;
      }
      const issues = createIssuesFromUnknownError(error, "$");
      lastIssues = issues;
      onDebug?.(
        `${taskId}: attempt ${attempt}/${config.ai.maxAttemptsPerTask} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      await writeRunFailureReport(
        paths,
        taskId,
        attempt,
        issues,
        previousResponse,
        error instanceof Error ? error.message : String(error),
      );
      onDebug?.(
        `${taskId}: wrote failure report for attempt ${attempt}/${config.ai.maxAttemptsPerTask}`,
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
  );
  onDebug?.(`${taskId}: exhausted all attempts without a valid result`);
  throw new Error(`Translation failed for ${taskId}`);
}

function verifyCandidateResult(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  segmentIndex: Map<string, SegmentRecord>,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): CandidateVerification {
  const errors = [
    ...validateTaskStructure(task),
    ...validateTaskFreshness(task, mapping, segmentIndex),
    ...validateTranslationsAgainstTask(task, mapping, result),
  ];
  const warnings = collectTranslationWarnings(task, result);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

function buildVerificationReport(options: {
  repoDir: string;
  taskId: string;
  resultPath: string;
  resultBody: string;
  verification: CandidateVerification;
}): TranslationVerificationReport {
  const { repoDir, taskId, resultPath, resultBody, verification } = options;

  return translationVerificationReportSchema.parse({
    schemaVersion: 1,
    taskId,
    checkedAt: createTimestamp(),
    resultFile: toRepoRelativePath(repoDir, resultPath),
    resultHash: hashString(resultBody),
    ok: verification.ok,
    errorCount: verification.errors.length,
    warningCount: verification.warnings.length,
    errors: verification.errors,
    warnings: verification.warnings,
  });
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
  paths: ReturnType<typeof getRepoPaths>,
  sourceUrl: string,
  targetLocale: string,
  plannedPages: PlannedPageTask[],
  logger: Logger,
): Promise<RetainPendingTasksResult> {
  const plannedPagesByUrl = new Map(
    plannedPages.map((plannedPage) => [plannedPage.pageUrl, plannedPage]),
  );
  const retainedPageUrls = new Set<string>();
  const files = await fg("*.json", {
    cwd: paths.tasksPendingDir,
    absolute: true,
  });
  const invalidatedTaskIds: string[] = [];
  let retainedTaskCount = 0;

  for (const filePath of files.sort()) {
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
      const taskId = getTaskIdFromPath(filePath);
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

async function syncTaskManifest(
  repoDir: string,
  sourceUrl: string,
  targetLocale: string,
  logger: Logger,
  invalidatedTaskIds: string[] = [],
): Promise<TranslationTaskManifest> {
  const paths = getRepoPaths(repoDir);
  const previousManifest = await loadTaskManifest(
    paths.taskManifestPath,
    sourceUrl,
    targetLocale,
    logger,
  );
  const entriesById = new Map<string, TranslationTaskManifestEntry>();

  const pendingTaskFiles = await fg("*.json", {
    cwd: paths.tasksPendingDir,
    absolute: true,
  });
  for (const taskFilePath of pendingTaskFiles.sort()) {
    try {
      const entry = await buildPendingTaskManifestEntry(
        repoDir,
        paths,
        taskFilePath,
        logger,
      );
      entriesById.set(entry.taskId, entry);
    } catch (error) {
      const taskId = getTaskIdFromPath(taskFilePath);
      if (taskId) {
        entriesById.set(
          taskId,
          buildInvalidManifestEntry({
            repoDir,
            taskId,
            taskFile: toRepoRelativePath(repoDir, taskFilePath),
            previousEntry: previousManifest.tasks.find(
              (task) => task.taskId === taskId,
            ),
          }),
        );
      }
      logger.warn(
        `Skipping unreadable task manifest entry ${taskFilePath}: ${String(error)}`,
      );
    }
  }

  const appliedTaskFiles = await fg("*.task.json", {
    cwd: paths.tasksAppliedDir,
    absolute: true,
  });
  for (const taskFilePath of appliedTaskFiles.sort()) {
    try {
      const entry = await buildAppliedTaskManifestEntry(
        repoDir,
        paths,
        taskFilePath,
        logger,
      );
      if (!entriesById.has(entry.taskId)) {
        entriesById.set(entry.taskId, entry);
      }
    } catch (error) {
      const taskId = basename(taskFilePath, ".task.json");
      if (taskId && !entriesById.has(taskId)) {
        entriesById.set(
          taskId,
          buildInvalidManifestEntry({
            repoDir,
            taskId,
            taskFile: toRepoRelativePath(repoDir, taskFilePath),
            doneResultFile: toRepoRelativePath(
              repoDir,
              getAppliedResultPath(paths.tasksAppliedDir, taskId),
            ),
            previousEntry: previousManifest.tasks.find(
              (task) => task.taskId === taskId,
            ),
          }),
        );
      }
      logger.warn(
        `Skipping unreadable applied task manifest entry ${taskFilePath}: ${String(error)}`,
      );
    }
  }

  for (const taskId of invalidatedTaskIds) {
    if (entriesById.has(taskId)) {
      continue;
    }

    const previousEntry = previousManifest.tasks.find(
      (task) => task.taskId === taskId,
    );
    entriesById.set(
      taskId,
      buildInvalidManifestEntry({
        repoDir,
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
  paths: ReturnType<typeof getRepoPaths>,
  taskFilePath: string,
  logger: Logger,
): Promise<TranslationTaskManifestEntry> {
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
      repoDir,
      taskId: task.taskId,
      taskFile: toRepoRelativePath(repoDir, taskFilePath),
      doneResultFile: toRepoRelativePath(repoDir, doneResultPath),
      page: task.page,
      contentCount: task.content.length,
      previousEntry: undefined,
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
  paths: ReturnType<typeof getRepoPaths>,
  taskFilePath: string,
  logger: Logger,
): Promise<TranslationTaskManifestEntry> {
  const task = parseTaskFile(await readJson(taskFilePath, {}));
  const taskId = basename(taskFilePath, ".task.json");
  const result = await loadResultFile(
    getAppliedResultPath(paths.tasksAppliedDir, taskId),
    logger,
  );
  const resultPath = getAppliedResultPath(paths.tasksAppliedDir, taskId);
  const report = await loadVerificationReport(
    getVerificationReportPath(paths, taskId),
    logger,
  );
  const runReport = await loadRunFailureReport(
    getRunFailureReportPath(paths, taskId),
  );

  if (!(await fs.pathExists(resultPath)) || !result) {
    return buildInvalidManifestEntry({
      repoDir,
      taskId,
      taskFile: toRepoRelativePath(repoDir, taskFilePath),
      doneResultFile: toRepoRelativePath(repoDir, resultPath),
      page: task.page,
      contentCount: task.content.length,
      previousEntry: undefined,
    });
  }

  return translationTaskManifestEntrySchema.parse({
    taskId,
    page: task.page,
    status: "applied",
    contentCount: task.content.length,
    taskFile: toRepoRelativePath(repoDir, taskFilePath),
    doneResultFile: result
      ? toRepoRelativePath(
          repoDir,
          getAppliedResultPath(paths.tasksAppliedDir, taskId),
        )
      : undefined,
    completedAt: result?.completedAt,
    provider: result?.provider,
    model: result?.model,
    lastVerifiedAt: report?.checkedAt,
    lastVerifyStatus: report ? (report.ok ? "pass" : "fail") : undefined,
    lastVerifyErrorCount: report?.errorCount,
    lastRunAt: runReport?.failedAt,
    lastRunStatus: runReport ? "fail" : undefined,
    lastRunError: runReport?.message,
  });
}

function createTaskManifestSummary(
  tasks: TranslationTaskManifestEntry[],
): TranslationTaskManifest["summary"] {
  const summary = {
    total: tasks.length,
    pending: 0,
    done: 0,
    applied: 0,
    invalid: 0,
  };

  tasks.forEach((task) => {
    if (task.status === "pending") {
      summary.pending += 1;
      return;
    }
    if (task.status === "done") {
      summary.done += 1;
      return;
    }
    if (task.status === "applied") {
      summary.applied += 1;
      return;
    }

    summary.invalid += 1;
  });

  return summary;
}

function renderTaskQueueBoard(manifest: TranslationTaskManifest): string {
  const lines = [
    "# DocuMirror Translation Queue",
    "",
    "This file is generated by DocuMirror. Do not edit it by hand.",
    "",
    `Generated: ${manifest.generatedAt}`,
    `Summary: total ${manifest.summary.total}, pending ${manifest.summary.pending}, done ${manifest.summary.done}, applied ${manifest.summary.applied}, invalid ${manifest.summary.invalid}`,
    "",
    "Run automatic translation with `documirror translate run --repo .`.",
    "",
    "## Tasks",
  ];

  if (manifest.tasks.length === 0) {
    lines.push("", "- [x] No translation tasks are currently queued.");
    return `${lines.join("\n")}\n`;
  }

  manifest.tasks.forEach((task) => {
    const checkbox =
      task.status === "done" || task.status === "applied" ? "[x]" : "[ ]";
    const title = task.page.title ? ` | ${task.page.title}` : "";
    const verify =
      task.lastVerifyStatus === undefined
        ? ""
        : ` | verify ${task.lastVerifyStatus}${
            task.lastVerifyErrorCount && task.lastVerifyErrorCount > 0
              ? ` (${task.lastVerifyErrorCount} errors)`
              : ""
          }`;
    const run =
      task.lastRunStatus === "fail" && task.lastRunError
        ? ` | last run failed: ${task.lastRunError}`
        : "";
    lines.push(
      `- ${checkbox} ${task.taskId} | ${task.status} | ${task.contentCount} items${title} | ${task.page.url}${verify}${run}`,
    );
  });

  return `${lines.join("\n")}\n`;
}

function buildInvalidManifestEntry(options: {
  repoDir: string;
  taskId: string;
  taskFile: string;
  doneResultFile?: string;
  page?: TranslationTaskManifestEntry["page"];
  contentCount?: number;
  previousEntry?: TranslationTaskManifestEntry;
}): TranslationTaskManifestEntry {
  const {
    repoDir,
    taskId,
    taskFile,
    doneResultFile,
    page,
    contentCount,
    previousEntry,
  } = options;

  return translationTaskManifestEntrySchema.parse({
    taskId,
    page: page ?? previousEntry?.page ?? { url: "" },
    status: "invalid",
    contentCount: contentCount ?? previousEntry?.contentCount ?? 0,
    taskFile:
      taskFile ||
      previousEntry?.taskFile ||
      toRepoRelativePath(repoDir, taskFile),
    doneResultFile: doneResultFile ?? previousEntry?.doneResultFile,
    completedAt: previousEntry?.completedAt,
    provider: previousEntry?.provider,
    model: previousEntry?.model,
    lastVerifiedAt: previousEntry?.lastVerifiedAt,
    lastVerifyStatus: previousEntry?.lastVerifyStatus,
    lastVerifyErrorCount: previousEntry?.lastVerifyErrorCount,
    lastRunAt: previousEntry?.lastRunAt,
    lastRunStatus: previousEntry?.lastRunStatus,
    lastRunError: previousEntry?.lastRunError,
  });
}

function compareManifestEntries(
  left: TranslationTaskManifestEntry,
  right: TranslationTaskManifestEntry,
): number {
  const statusDiff =
    TASK_STATUS_ORDER[left.status] - TASK_STATUS_ORDER[right.status];
  if (statusDiff !== 0) {
    return statusDiff;
  }

  const pageDiff = left.page.url.localeCompare(right.page.url);
  if (pageDiff !== 0) {
    return pageDiff;
  }

  return left.taskId.localeCompare(right.taskId);
}

function validateTaskStructure(
  task: TranslationTaskFile,
): TranslationVerificationIssue[] {
  const expectedIds = task.content.map((_, index) => String(index + 1));
  return validateOrderedIds({
    actualIds: task.content.map((item) => item.id),
    expectedIds,
    collectionPath: "$.content",
    elementPath: "$.content",
    itemLabel: "task content id",
  });
}

function validateTaskFreshness(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  segmentIndex: Map<string, SegmentRecord>,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];
  const taskContentIndex = new Map(
    task.content.map((item, index) => [item.id, index]),
  );

  mapping.items.forEach((item, index) => {
    const contentIndex = taskContentIndex.get(item.id) ?? index;
    const segmentRefs =
      item.kind === "segment" ? [item.segment] : item.segments;

    segmentRefs.forEach((segmentRef) => {
      const currentSegment = segmentIndex.get(segmentRef.segmentId);
      if (!currentSegment) {
        issues.push({
          code: "task_segment_missing",
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} no longer exists; rerun translate plan`,
          jsonPath: `$.content[${contentIndex}]`,
        });
        return;
      }

      if (currentSegment.sourceHash !== segmentRef.sourceHash) {
        issues.push({
          code: "task_stale",
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} changed; rerun translate plan`,
          jsonPath: `$.content[${contentIndex}]`,
        });
      }
    });
  });

  return dedupeIssues(issues);
}

function validateTranslationsAgainstTask(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];
  const expectedIds = task.content.map((_, index) => String(index + 1));
  const taskContentIndex = new Map(task.content.map((item) => [item.id, item]));

  if (mapping.items.length !== task.content.length) {
    issues.push({
      code: "mapping_item_count_mismatch",
      message: `Task mapping item count ${mapping.items.length} does not match task content count ${task.content.length}`,
      jsonPath: "$.content",
    });
  }

  if (result.taskId !== task.taskId) {
    issues.push({
      code: "task_id_mismatch",
      message: `Expected taskId "${task.taskId}" but got "${result.taskId}"`,
      jsonPath: "$.taskId",
    });
  }

  issues.push(
    ...validateOrderedIds({
      actualIds: result.translations.map((item) => item.id),
      expectedIds,
      collectionPath: "$.translations",
      elementPath: "$.translations",
      itemLabel: "translation id",
    }),
  );

  if (result.translations.length !== task.content.length) {
    issues.push({
      code: "translation_count_mismatch",
      message: `Expected ${task.content.length} translations but found ${result.translations.length}; make translations length match task.content exactly`,
      jsonPath: "$.translations",
    });
  }

  const mappingIndex = new Map(mapping.items.map((item) => [item.id, item]));

  result.translations.forEach((item, index) => {
    const taskItem = taskContentIndex.get(item.id);

    if (item.translatedText.trim().length === 0) {
      issues.push({
        code: "translation_empty",
        message: `Translation for id "${item.id}" is empty; fill translatedText with the completed translation`,
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }

    const mappedItem = mappingIndex.get(item.id);
    if (!mappedItem) {
      issues.push({
        code: "translation_id_unknown",
        message: `Translation id "${item.id}" is not present in the task mapping`,
        jsonPath: `$.translations[${index}].id`,
      });
      return;
    }

    if (taskItem) {
      issues.push(
        ...validateListMarkerPrefix(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validateLightweightMarkupStructure(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validatePlaceholderTokens(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validateGlossaryTargets(
          task.glossary,
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
    }

    if (mappedItem.kind === "segment") {
      return;
    }

    const translatedSegments = splitByInlineCodeSpans(
      item.translatedText,
      mappedItem.inlineCodeSpans.map((inlineCodeSpan) => inlineCodeSpan.text),
      mappedItem.textSlotIndices,
    );
    if (!translatedSegments) {
      issues.push({
        code: "inline_code_mismatch",
        message: `Translation for id "${item.id}" must preserve inline code spans ${JSON.stringify(
          mappedItem.inlineCodeSpans.map(
            (inlineCodeSpan) => inlineCodeSpan.text,
          ),
        )} in the original order`,
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }
  });

  return dedupeIssues(issues);
}

function collectTranslationWarnings(
  task: TranslationTaskFile,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): TranslationVerificationIssue[] {
  const warnings: TranslationVerificationIssue[] = [];
  const taskContentIndex = new Map(task.content.map((item) => [item.id, item]));

  result.translations.forEach((item, index) => {
    const taskItem = taskContentIndex.get(item.id);
    if (!taskItem) {
      return;
    }

    if (looksUntranslated(taskItem.text, item.translatedText)) {
      warnings.push({
        code: "translation_suspiciously_identical",
        message: `Translation for id "${item.id}" is effectively identical to the source text; confirm that the text really should stay untranslated`,
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }
  });

  return dedupeIssues(warnings);
}

function dedupeIssues(
  issues: TranslationVerificationIssue[],
): TranslationVerificationIssue[] {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.code}::${issue.jsonPath}::${issue.message}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function validateOrderedIds(options: {
  actualIds: string[];
  expectedIds: string[];
  collectionPath: string;
  elementPath: string;
  itemLabel: string;
}): TranslationVerificationIssue[] {
  const { actualIds, expectedIds, collectionPath, elementPath, itemLabel } =
    options;
  const issues: TranslationVerificationIssue[] = [];
  const expectedIdSet = new Set(expectedIds);
  const seenIds = new Set<string>();

  actualIds.forEach((id, index) => {
    const expectedId = expectedIds[index];
    if (expectedId !== undefined && id !== expectedId) {
      issues.push({
        code: "id_out_of_order",
        message: `Expected ${itemLabel} "${expectedId}" at position ${
          index + 1
        } but found "${id}"; renumber items to match 1..${expectedIds.length}`,
        jsonPath: `${elementPath}[${index}].id`,
      });
    }

    if (seenIds.has(id)) {
      issues.push({
        code: "id_duplicate",
        message: `Duplicate ${itemLabel} "${id}" found; each id must appear exactly once`,
        jsonPath: `${elementPath}[${index}].id`,
      });
    }
    seenIds.add(id);
  });

  const missingIds = expectedIds.filter((id) => !actualIds.includes(id));
  if (missingIds.length > 0) {
    issues.push({
      code: "id_missing",
      message: `Missing ${itemLabel}${missingIds.length > 1 ? "s" : ""} ${missingIds
        .map((id) => `"${id}"`)
        .join(", ")}; add the missing items so ids run strictly from 1 to ${
        expectedIds.length
      }`,
      jsonPath: collectionPath,
    });
  }

  const extraIds = actualIds.filter((id) => !expectedIdSet.has(id));
  if (extraIds.length > 0) {
    issues.push({
      code: "id_unknown",
      message: `Unexpected ${itemLabel}${extraIds.length > 1 ? "s" : ""} ${extraIds
        .map((id) => `"${id}"`)
        .join(", ")}; remove ids that are not present in the task`,
      jsonPath: collectionPath,
    });
  }

  return issues;
}

function validatePlaceholderTokens(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceTokens = extractPlaceholderTokens(sourceText);
  if (sourceTokens.length === 0) {
    return [];
  }

  const translatedTokens = extractPlaceholderTokens(translatedText);
  if (areStringMultisetsEqual(sourceTokens, translatedTokens)) {
    return [];
  }

  return [
    {
      code: "placeholder_mismatch",
      message: `Translation must preserve placeholders ${JSON.stringify(sourceTokens)} exactly`,
      jsonPath,
    },
  ];
}

function validateListMarkerPrefix(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceMarker = extractListMarkerPrefix(sourceText);
  if (!sourceMarker) {
    return [];
  }

  const translatedMarker = extractListMarkerPrefix(translatedText);
  if (translatedMarker === sourceMarker) {
    return [];
  }

  return [
    {
      code: "list_marker_mismatch",
      message: `Translation must preserve the leading list marker "${sourceMarker}"`,
      jsonPath,
    },
  ];
}

function validateLightweightMarkupStructure(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceSignature = getLightweightMarkupSignature(sourceText);
  const translatedSignature = getLightweightMarkupSignature(translatedText);
  const sourceEntries = Object.entries(sourceSignature).filter(
    ([, count]) => count > 0,
  );

  if (
    sourceEntries.every(
      ([key, count]) =>
        translatedSignature[key as keyof typeof translatedSignature] === count,
    )
  ) {
    return [];
  }

  const requiredFragments = sourceEntries
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  return [
    {
      code: "markup_structure_mismatch",
      message: `Translation must preserve lightweight markup structure (${requiredFragments})`,
      jsonPath,
    },
  ];
}

function validateGlossaryTargets(
  glossary: TranslationTaskFile["glossary"],
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];

  glossary.forEach((entry) => {
    const sourceTerm = entry.source.trim();
    const targetTerm = entry.target.trim();
    if (!sourceTerm || !targetTerm) {
      return;
    }

    if (!containsGlossaryTerm(sourceText, sourceTerm)) {
      return;
    }

    if (containsGlossaryTerm(translatedText, targetTerm)) {
      return;
    }

    issues.push({
      code: "glossary_target_missing",
      message: `Translation must include glossary target "${targetTerm}" when the source contains "${sourceTerm}"`,
      jsonPath,
    });
  });

  return issues;
}

function extractListMarkerPrefix(value: string): string | null {
  const match = value.match(/^\s*(?:[-*+]\s+\[(?: |x|X)\]|[-*+]|\d+\.)\s+/u);
  return match?.[0] ?? null;
}

function getLightweightMarkupSignature(value: string): Record<string, number> {
  const comparableText = stripInlineCodeText(value);

  return {
    boldAsterisk: countMatches(comparableText, /\*\*[^*\n][\s\S]*?\*\*/gu),
    boldUnderscore: countMatches(comparableText, /__[^_\n][\s\S]*?__/gu),
    strike: countMatches(comparableText, /~~[^~\n][\s\S]*?~~/gu),
    image: countMatches(comparableText, /!\[[^\]]+\]\([^)]+\)/gu),
    link: countMatches(comparableText, /(?<!!)\[[^\]]+\]\([^)]+\)/gu),
  };
}

function areStringMultisetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const counts = new Map<string, number>();
  left.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  right.forEach((value) => {
    const next = (counts.get(value) ?? 0) - 1;
    counts.set(value, next);
  });

  return [...counts.values()].every((count) => count === 0);
}

function containsGlossaryTerm(text: string, term: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }

  if (/^[A-Za-z0-9_-]+$/u.test(normalizedTerm)) {
    return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "iu").test(
      normalizedText,
    );
  }

  return normalizedText
    .toLocaleLowerCase()
    .includes(normalizedTerm.toLocaleLowerCase());
}

function looksUntranslated(
  sourceText: string,
  translatedText: string,
): boolean {
  const comparableSource = stripComparableText(sourceText);
  const comparableTranslation = stripComparableText(translatedText);

  return (
    comparableSource.length > 0 &&
    comparableSource === comparableTranslation &&
    /[\p{L}\p{N}]/u.test(comparableSource)
  );
}

function stripComparableText(value: string): string {
  return normalizeText(
    replacePlaceholderTokens(stripInlineCodeText(value), " "),
  )
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function stripInlineCodeText(value: string): string {
  const inlineCodeParsed = parseInlineCodeSpans(value);
  return inlineCodeParsed ? inlineCodeParsed.textSegments.join(" ") : value;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createIssuesFromUnknownError(
  error: unknown,
  rootPath: string,
): TranslationVerificationIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      jsonPath: toJsonPath(
        rootPath,
        issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      ),
    }));
  }

  if (error instanceof Error && error.name === "SyntaxError") {
    return [
      {
        code: "json_invalid",
        message: `Result file is not valid JSON: ${error.message}`,
        jsonPath: rootPath,
      },
    ];
  }

  return [
    {
      code: "unknown_error",
      message: String(error),
      jsonPath: rootPath,
    },
  ];
}

function toJsonPath(rootPath: string, path: Array<string | number>): string {
  return path.reduce<string>((currentPath, segment) => {
    if (typeof segment === "number") {
      return `${currentPath}[${segment}]`;
    }

    return `${currentPath}.${segment}`;
  }, rootPath);
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
    const currentSegment = segmentIndex.get(segmentRef.segmentId);
    translationIndex.set(segmentRef.segmentId, {
      segmentId: segmentRef.segmentId,
      reuseKey: currentSegment?.reuseKey,
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

function getPendingTaskPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.tasksPendingDir, `${taskId}.json`);
}

function getDoneResultPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.tasksDoneDir, `${taskId}.json`);
}

function getVerificationReportPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.reportsDir, VERIFY_REPORT_DIR, `${taskId}.json`);
}

function getRunFailureReportPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.reportsDir, RUN_REPORT_DIR, `${taskId}.json`);
}

function getTaskMappingPath(taskMappingsDir: string, taskId: string): string {
  return join(taskMappingsDir, `${taskId}.json`);
}

function getAppliedTaskPath(tasksAppliedDir: string, taskId: string): string {
  return join(tasksAppliedDir, `${taskId}.task.json`);
}

function getAppliedTaskHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(tasksAppliedHistoryDir, `${taskId}--${archiveStamp}.task.json`);
}

function getAppliedTaskMappingPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.mapping.json`);
}

function getAppliedTaskMappingHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(
    tasksAppliedHistoryDir,
    `${taskId}--${archiveStamp}.mapping.json`,
  );
}

function getAppliedResultPath(tasksAppliedDir: string, taskId: string): string {
  return join(tasksAppliedDir, `${taskId}.json`);
}

function getAppliedResultHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(tasksAppliedHistoryDir, `${taskId}--${archiveStamp}.json`);
}

function getTaskIdFromPath(filePath: string): string {
  return basename(filePath, ".json");
}

function toRepoRelativePath(repoDir: string, filePath: string): string {
  return relative(repoDir, filePath);
}

async function loadTaskArtifacts(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): Promise<{
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
}> {
  const pendingTaskPath = getPendingTaskPath(paths, taskId);
  const appliedTaskPath = getAppliedTaskPath(paths.tasksAppliedDir, taskId);
  const taskPath = (await fs.pathExists(pendingTaskPath))
    ? pendingTaskPath
    : appliedTaskPath;
  if (!(await fs.pathExists(taskPath))) {
    throw new Error(
      `Task ${taskId} is not available under pending or applied tasks`,
    );
  }

  const pendingMappingPath = getTaskMappingPath(paths.taskMappingsDir, taskId);
  const appliedMappingPath = getAppliedTaskMappingPath(
    paths.tasksAppliedDir,
    taskId,
  );
  const mappingPath = (await fs.pathExists(pendingMappingPath))
    ? pendingMappingPath
    : appliedMappingPath;
  if (!(await fs.pathExists(mappingPath))) {
    throw new Error(`Task mapping for ${taskId} is missing or unreadable`);
  }

  return {
    task: parseTaskFile(await readJson(taskPath, {})),
    mapping: parseTaskMappingFile(await readJson(mappingPath, {})),
  };
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

async function loadTaskManifest(
  taskManifestPath: string,
  sourceUrl: string,
  targetLocale: string,
  logger: Logger,
): Promise<TranslationTaskManifest> {
  try {
    return translationTaskManifestSchema.parse(
      await readJson(
        taskManifestPath,
        createEmptyTaskManifest(sourceUrl, targetLocale),
      ),
    );
  } catch (error) {
    logger.warn(
      `Resetting unreadable task manifest ${taskManifestPath}: ${String(error)}`,
    );
    return createEmptyTaskManifest(sourceUrl, targetLocale);
  }
}

function createEmptyTaskManifest(
  sourceUrl: string,
  targetLocale: string,
): TranslationTaskManifest {
  return translationTaskManifestSchema.parse({
    schemaVersion: 1,
    generatedAt: createTimestamp(),
    sourceUrl,
    targetLocale,
    summary: {
      total: 0,
      pending: 0,
      done: 0,
      applied: 0,
      invalid: 0,
    },
    tasks: [],
  });
}

async function loadVerificationReport(
  filePath: string,
  logger?: Logger,
): Promise<TranslationVerificationReport | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return translationVerificationReportSchema.parse(
      await readJson(filePath, {}),
    );
  } catch (error) {
    logger?.warn(
      `Ignoring unreadable verification report ${filePath}: ${String(error)}`,
    );
    return null;
  }
}

async function loadResultFile(
  filePath: string,
  logger: Logger,
): Promise<TranslationResultFile | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return parseResultFile(await readJson(filePath, {}));
  } catch (error) {
    logger.warn(
      `Ignoring unreadable result file ${filePath}: ${String(error)}`,
    );
    return null;
  }
}

async function loadRunFailureReport(
  filePath: string,
): Promise<RunFailureReport | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return (await readJson(filePath, null)) as RunFailureReport | null;
  } catch {
    return null;
  }
}

async function writeRunFailureReport(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
  attemptCount: number,
  errors: TranslationVerificationIssue[],
  resultPreview: string | undefined,
  message: string,
): Promise<void> {
  const report: RunFailureReport = {
    schemaVersion: 1,
    taskId,
    failedAt: createTimestamp(),
    attemptCount,
    resultPreview,
    errors,
    message,
  };
  await writeJson(getRunFailureReportPath(paths, taskId), report);
}

async function removePendingTaskBundle(
  paths: ReturnType<typeof getRepoPaths>,
  taskFilePath: string,
  taskId: string,
): Promise<void> {
  await fs.remove(taskFilePath);
  if (taskId) {
    await fs.remove(getTaskMappingPath(paths.taskMappingsDir, taskId));
    await fs.remove(getDoneResultPath(paths, taskId));
    await fs.remove(getVerificationReportPath(paths, taskId));
    await fs.remove(getRunFailureReportPath(paths, taskId));
  }
}

async function archivePendingTaskFile(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
  archiveStamp: string,
): Promise<void> {
  const pendingTaskPath = getPendingTaskPath(paths, taskId);
  if (!(await fs.pathExists(pendingTaskPath))) {
    return;
  }

  await fs.copy(
    pendingTaskPath,
    getAppliedTaskPath(paths.tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
  await fs.copy(
    pendingTaskPath,
    getAppliedTaskHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    ),
  );
  await fs.remove(pendingTaskPath);
}

async function archiveTaskMapping(
  taskId: string,
  paths: ReturnType<typeof getRepoPaths>,
  archiveStamp: string,
): Promise<void> {
  const mappingPath = getTaskMappingPath(paths.taskMappingsDir, taskId);
  if (!(await fs.pathExists(mappingPath))) {
    return;
  }

  await fs.copy(
    mappingPath,
    getAppliedTaskMappingPath(paths.tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
  await fs.copy(
    mappingPath,
    getAppliedTaskMappingHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    ),
  );
  await fs.remove(mappingPath);
}

function isSerializedEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseCandidateResult(body: string): TranslationResultFile {
  return parseResultFile(JSON.parse(body));
}

function createTaskId(pageUrl: string): string {
  return `task_${hashString(pageUrl).slice(0, 10)}`;
}

function createArchiveStamp(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

async function archiveDoneResultFile(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
  resultPath: string,
  archiveStamp: string,
): Promise<void> {
  if (!(await fs.pathExists(resultPath))) {
    return;
  }

  await fs.copy(
    resultPath,
    getAppliedResultPath(paths.tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
  await fs.copy(
    resultPath,
    getAppliedResultHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    ),
  );
  await fs.remove(resultPath);
}

function createRunDebugEmitter(
  onDebug?: (message: string) => void,
): (message: string) => void {
  if (!onDebug) {
    return () => {};
  }

  return (message: string) => {
    onDebug(message);
  };
}

function formatIssueSummary(
  issue: TranslationVerificationIssue | undefined,
): string {
  if (!issue) {
    return "unknown error";
  }

  return `[${issue.code}] ${issue.message}`;
}

function formatRunDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${totalSeconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason));
  }
}

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }

  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "APIUserAbortError" ||
      error.message === "Request was aborted."
    );
  }

  return false;
}
