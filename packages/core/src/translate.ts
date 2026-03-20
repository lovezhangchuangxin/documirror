import { open } from "node:fs/promises";

import fg from "fast-glob";
import fs from "fs-extra";
import { nanoid } from "nanoid";
import { basename, join, relative } from "pathe";
import { ZodError } from "zod";

import {
  createTaskBundle,
  parseDraftResultFile,
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
  TranslationTaskClaimFile,
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
  DEFAULT_TASK_LEASE_MINUTES,
  defaultLogger,
  hashString,
  normalizeText,
  translationTaskClaimFileSchema,
  translationTaskManifestEntrySchema,
  translationTaskManifestSchema,
  translationVerificationReportSchema,
} from "@documirror/shared";

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
  ClaimSummary,
  CompleteSummary,
  PlanSummary,
  ReclaimExpiredSummary,
  ReleaseSummary,
  VerifySummary,
} from "./types";

const VERIFY_REPORT_DIR = "translation-verify";
const PLACEHOLDER_TOKEN_REGEX =
  /\{\{[^{}]+\}\}|\{[A-Za-z0-9_.-]+\}|%(\d+\$)?[+#0\- ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[sdifo]|<\/?\d+>|\$[A-Z_][A-Z0-9_]*/gu;
const TASK_STATUS_ORDER = {
  pending: 0,
  "in-progress": 1,
  done: 2,
  applied: 3,
  invalid: 4,
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

type NormalizedTaskClaimFile = Omit<
  TranslationTaskClaimFile,
  "claimId" | "claimedBy" | "leaseUntil"
> & {
  claimId: string;
  claimedBy: string;
  leaseUntil: string;
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
    const taskId = `task_${nanoid(10)}`;
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

export async function claimTranslationTask(
  repoDir: string,
  options: {
    taskId?: string;
    workerId?: string;
    leaseMinutes?: number;
  } = {},
  logger: Logger = defaultLogger,
): Promise<ClaimSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const workerId = options.workerId?.trim() || "unknown";
  const leaseMinutes = normalizeLeaseMinutes(options.leaseMinutes);
  await reclaimExpiredTaskClaims(paths, logger);
  const taskManifest = await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  const candidates = options.taskId
    ? [taskManifest.tasks.find((task) => task.taskId === options.taskId)]
    : taskManifest.tasks.filter((task) => task.status === "pending");

  if (candidates.length === 0 || !candidates[0]) {
    throw new Error(
      options.taskId
        ? `Task ${options.taskId} was not found in the current translation queue`
        : "No pending translation tasks are available to claim",
    );
  }

  if (options.taskId && candidates[0].status !== "pending") {
    const claimOwner = candidates[0].claimedBy
      ? ` by ${candidates[0].claimedBy}`
      : "";
    const leaseUntil = candidates[0].leaseUntil
      ? ` until ${candidates[0].leaseUntil}`
      : "";
    throw new Error(
      `Task ${candidates[0].taskId} is ${candidates[0].status}${claimOwner}${leaseUntil} and cannot be claimed`,
    );
  }

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const claimed = await tryClaimTask(repoDir, paths, {
      taskId: candidate.taskId,
      workerId,
      leaseMinutes,
    });
    if (claimed) {
      await syncTaskManifest(
        repoDir,
        config.sourceUrl,
        config.targetLocale,
        logger,
      );
      return claimed;
    }
  }

  throw new Error(
    options.taskId
      ? `Task ${options.taskId} was claimed by another worker before it could be claimed`
      : "No pending translation tasks are available to claim",
  );
}

export async function releaseTranslationTask(
  repoDir: string,
  options: {
    taskId: string;
    dropDraft?: boolean;
  },
  logger: Logger = defaultLogger,
): Promise<ReleaseSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const taskPath = getPendingTaskPath(paths, options.taskId);
  const claimPath = getTaskClaimPath(paths, options.taskId);
  const doneResultPath = getDoneResultPath(paths, options.taskId);

  if (!(await fs.pathExists(taskPath))) {
    throw new Error(
      `Task ${options.taskId} was not found in the current translation queue`,
    );
  }

  if (await fs.pathExists(doneResultPath)) {
    throw new Error(
      `Task ${options.taskId} is already complete and cannot be released`,
    );
  }

  const claim = await loadClaimFile(claimPath, logger);
  if (!claim) {
    throw new Error(`Task ${options.taskId} is not currently claimed`);
  }

  await fs.remove(claimPath);
  await fs.remove(getVerificationReportPath(paths, options.taskId));

  let removedDraft = false;
  if (options.dropDraft) {
    await fs.remove(getDraftResultPath(paths, options.taskId));
    removedDraft = true;
  }

  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    taskId: options.taskId,
    removedDraft,
    wasExpired: isClaimExpired(claim),
  };
}

export async function reclaimExpiredTranslationTasks(
  repoDir: string,
  options: {
    dropDraft?: boolean;
  } = {},
  logger: Logger = defaultLogger,
): Promise<ReclaimExpiredSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const { taskIds, removedDraftCount } = await reclaimExpiredTaskClaims(
    paths,
    logger,
    {
      dropDraft: options.dropDraft,
    },
  );

  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    reclaimedTaskCount: taskIds.length,
    taskIds,
    removedDraftCount,
  };
}

export async function verifyTranslationTask(
  repoDir: string,
  taskId: string,
  logger: Logger = defaultLogger,
): Promise<VerifySummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segmentIndex = new Map(
    (await loadSegments(paths)).map((segment) => [segment.segmentId, segment]),
  );
  const taskPath = getPendingTaskPath(paths, taskId);
  const draftResultPath = getDraftResultPath(paths, taskId);

  if (!(await fs.pathExists(taskPath))) {
    throw new Error(`Task ${taskId} is not available under pending tasks`);
  }

  if (!(await fs.pathExists(draftResultPath))) {
    throw new Error(
      `Draft result file is missing: ${toRepoRelativePath(repoDir, draftResultPath)}`,
    );
  }

  const task = parseTaskFile(await readJson(taskPath, {}));
  const mapping = await loadTaskMapping(paths.taskMappingsDir, taskId);
  if (!mapping) {
    throw new Error(`Task mapping for ${taskId} is missing or unreadable`);
  }
  const claim = await loadClaimFile(getTaskClaimPath(paths, taskId), logger);

  const draftBody = await fs.readFile(draftResultPath, "utf8");
  const draftResultHash = hashString(draftBody);
  const checkedAt = createTimestamp();
  const warnings: TranslationVerificationIssue[] = [];
  const issues: TranslationVerificationIssue[] = [];
  let draft: TranslationDraftResultFile | null = null;

  try {
    draft = parseDraftResultFile(JSON.parse(draftBody));
  } catch (error) {
    issues.push(...createIssuesFromUnknownError(error, "$"));
  }

  if (draft) {
    issues.push(...validateTaskStructure(task));
    issues.push(...validateTaskFreshness(task, mapping, segmentIndex));
    issues.push(...validateTranslationsAgainstTask(task, mapping, draft));
    warnings.push(...collectTranslationWarnings(task, draft));
    if (claim && isClaimExpired(claim)) {
      issues.push({
        code: "claim_expired",
        message: `Task ${taskId} claim expired at ${claim.leaseUntil}; reclaim the task before completing it`,
        jsonPath: "$",
      });
    }
  }

  const report = translationVerificationReportSchema.parse({
    schemaVersion: 1,
    taskId,
    checkedAt,
    draftResultFile: toRepoRelativePath(repoDir, draftResultPath),
    draftResultHash,
    claimId: claim?.claimId,
    claimedBy: claim?.claimedBy,
    ok: issues.length === 0,
    errorCount: issues.length,
    warningCount: dedupeIssues(warnings).length,
    errors: issues,
    warnings: dedupeIssues(warnings),
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

export async function completeTranslationTask(
  repoDir: string,
  options: {
    taskId: string;
    provider: string;
  },
  logger: Logger = defaultLogger,
): Promise<CompleteSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segmentIndex = new Map(
    (await loadSegments(paths)).map((segment) => [segment.segmentId, segment]),
  );
  const taskPath = getPendingTaskPath(paths, options.taskId);
  const draftResultPath = getDraftResultPath(paths, options.taskId);
  const reportPath = getVerificationReportPath(paths, options.taskId);
  const claim = await loadClaimFile(
    getTaskClaimPath(paths, options.taskId),
    logger,
  );

  if (!(await fs.pathExists(taskPath))) {
    throw new Error(
      `Task ${options.taskId} is not available under pending tasks`,
    );
  }

  if (!(await fs.pathExists(draftResultPath))) {
    throw new Error(
      `Draft result file is missing: ${toRepoRelativePath(repoDir, draftResultPath)}`,
    );
  }

  if (!claim) {
    throw new Error(
      `Task ${options.taskId} must be claimed before it can be completed`,
    );
  }

  if (isClaimExpired(claim)) {
    throw new Error(
      `Task ${options.taskId} claim expired at ${claim.leaseUntil}; reclaim the task and rerun translate verify`,
    );
  }

  const report = await loadVerificationReport(reportPath);
  if (!report || !report.ok) {
    throw new Error(
      `Task ${options.taskId} must pass translate verify before completion`,
    );
  }

  const draftBody = await fs.readFile(draftResultPath, "utf8");
  const draftResultHash = hashString(draftBody);
  if (draftResultHash !== report.draftResultHash) {
    throw new Error(
      `Draft result for ${options.taskId} changed after verification; rerun translate verify`,
    );
  }

  if (report.claimId && report.claimId !== claim.claimId) {
    throw new Error(
      `Verification report for ${options.taskId} does not match the current claim; rerun translate verify`,
    );
  }

  const mapping = await loadTaskMapping(paths.taskMappingsDir, options.taskId);
  if (!mapping) {
    throw new Error(
      `Task mapping for ${options.taskId} is missing or unreadable`,
    );
  }

  const task = parseTaskFile(await readJson(taskPath, {}));
  const freshnessIssues = validateTaskFreshness(task, mapping, segmentIndex);
  if (freshnessIssues.length > 0) {
    throw new Error(
      `${freshnessIssues[0]?.message ?? `Task ${options.taskId} is stale; rerun translate plan and claim a new task`}`,
    );
  }

  const draft = parseDraftResultFile(JSON.parse(draftBody));
  const resultPath = getDoneResultPath(paths, options.taskId);
  await writeJson(resultPath, {
    schemaVersion: 2,
    taskId: options.taskId,
    provider: options.provider,
    completedAt: createTimestamp(),
    translations: draft.translations,
  });

  await fs.remove(draftResultPath);
  await fs.remove(getTaskClaimPath(paths, options.taskId));
  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    taskId: options.taskId,
    resultFile: toRepoRelativePath(repoDir, resultPath),
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
        provider: parsed.provider,
        completedAt: parsed.completedAt,
        filePath,
        segmentIndex,
        translationIndex,
        logger,
      });
      appliedSegments += appliedCount;
    }

    await archivePendingTaskFile(paths, parsed.taskId);
    await archiveTaskMapping(
      paths.taskMappingsDir,
      paths.tasksAppliedDir,
      parsed.taskId,
    );
    await fs.remove(getTaskClaimPath(paths, parsed.taskId));
    await fs.remove(getDraftResultPath(paths, parsed.taskId));
    await fs.move(
      filePath,
      getAppliedResultPath(paths.tasksAppliedDir, parsed.taskId),
      {
        overwrite: true,
      },
    );
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
      translationTaskManifestEntrySchema.parse({
        taskId,
        page: previousEntry?.page ?? {
          url: "",
        },
        status: "invalid",
        contentCount: previousEntry?.contentCount ?? 0,
        taskFile:
          previousEntry?.taskFile ??
          toRepoRelativePath(repoDir, getPendingTaskPath(paths, taskId)),
        draftResultFile: previousEntry?.draftResultFile,
        doneResultFile: previousEntry?.doneResultFile,
        claimId: previousEntry?.claimId,
        claimedAt: previousEntry?.claimedAt,
        claimedBy: previousEntry?.claimedBy,
        leaseUntil: previousEntry?.leaseUntil,
        leaseExpired: previousEntry?.leaseExpired,
        completedAt: previousEntry?.completedAt,
        provider: previousEntry?.provider,
        lastVerifiedAt: previousEntry?.lastVerifiedAt,
        lastVerifyStatus: previousEntry?.lastVerifyStatus,
        lastVerifyErrorCount: previousEntry?.lastVerifyErrorCount,
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
  const claimPath = getTaskClaimPath(paths, task.taskId);
  const draftResultPath = getDraftResultPath(paths, task.taskId);
  const doneResultPath = getDoneResultPath(paths, task.taskId);
  const claim = await loadClaimFile(claimPath, logger);
  const report = await loadVerificationReport(
    getVerificationReportPath(paths, task.taskId),
    logger,
  );
  const doneResult = await loadResultFile(doneResultPath, logger);
  const hasDraft = await fs.pathExists(draftResultPath);
  const hasDoneResult = await fs.pathExists(doneResultPath);
  const leaseExpired = claim ? isClaimExpired(claim) : false;

  return translationTaskManifestEntrySchema.parse({
    taskId: task.taskId,
    page: task.page,
    status: hasDoneResult ? "done" : claim ? "in-progress" : "pending",
    contentCount: task.content.length,
    taskFile: toRepoRelativePath(repoDir, taskFilePath),
    draftResultFile:
      claim?.draftResultFile ??
      (hasDraft ? toRepoRelativePath(repoDir, draftResultPath) : undefined),
    doneResultFile: hasDoneResult
      ? toRepoRelativePath(repoDir, doneResultPath)
      : undefined,
    claimId: claim?.claimId,
    claimedAt: claim?.claimedAt,
    claimedBy: claim?.claimedBy,
    leaseUntil: claim?.leaseUntil,
    leaseExpired: leaseExpired || undefined,
    completedAt: doneResult?.completedAt,
    provider: doneResult?.provider,
    lastVerifiedAt: report?.checkedAt,
    lastVerifyStatus: report ? (report.ok ? "pass" : "fail") : undefined,
    lastVerifyErrorCount: report?.errorCount,
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
  const report = await loadVerificationReport(
    getVerificationReportPath(paths, taskId),
    logger,
  );

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
    lastVerifiedAt: report?.checkedAt,
    lastVerifyStatus: report ? (report.ok ? "pass" : "fail") : undefined,
    lastVerifyErrorCount: report?.errorCount,
  });
}

function createTaskManifestSummary(
  tasks: TranslationTaskManifestEntry[],
): TranslationTaskManifest["summary"] {
  const summary = {
    total: tasks.length,
    pending: 0,
    inProgress: 0,
    done: 0,
    applied: 0,
    invalid: 0,
  };

  tasks.forEach((task) => {
    if (task.status === "in-progress") {
      summary.inProgress += 1;
      return;
    }

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
    `Summary: total ${manifest.summary.total}, pending ${manifest.summary.pending}, in-progress ${manifest.summary.inProgress}, done ${manifest.summary.done}, applied ${manifest.summary.applied}, invalid ${manifest.summary.invalid}`,
    "",
    "Claim the next task with `documirror translate claim --repo .`.",
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
    const claim =
      task.claimedBy || task.leaseUntil
        ? ` | claim ${task.claimedBy ?? "unknown"}${
            task.leaseUntil ? ` until ${task.leaseUntil}` : ""
          }${task.leaseExpired ? " (expired)" : ""}`
        : "";
    const verify =
      task.lastVerifyStatus === undefined
        ? ""
        : ` | verify ${task.lastVerifyStatus}${
            task.lastVerifyErrorCount && task.lastVerifyErrorCount > 0
              ? ` (${task.lastVerifyErrorCount} errors)`
              : ""
          }`;
    lines.push(
      `- ${checkbox} ${task.taskId} | ${task.status} | ${task.contentCount} items${title} | ${task.page.url}${claim}${verify}`,
    );
  });

  return `${lines.join("\n")}\n`;
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
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} no longer exists; rerun translate plan and claim a new task`,
          jsonPath: `$.content[${contentIndex}]`,
        });
        return;
      }

      if (currentSegment.sourceHash !== segmentRef.sourceHash) {
        issues.push({
          code: "task_stale",
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} changed; rerun translate plan and claim a new task`,
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
      message: `Translation must preserve placeholders ${JSON.stringify(
        sourceTokens,
      )} exactly`,
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

function extractPlaceholderTokens(value: string): string[] {
  PLACEHOLDER_TOKEN_REGEX.lastIndex = 0;
  return [...value.matchAll(PLACEHOLDER_TOKEN_REGEX)].map((match) => match[0]);
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
    if (next < 0) {
      counts.set(value, next);
      return;
    }

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
    stripInlineCodeText(value).replace(PLACEHOLDER_TOKEN_REGEX, " "),
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
        message: `Draft result file is not valid JSON: ${error.message}`,
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

function getDraftResultPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.tasksInProgressDir, `${taskId}.result.json`);
}

function getTaskClaimPath(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): string {
  return join(paths.tasksInProgressDir, `${taskId}.claim.json`);
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

function getTaskMappingPath(taskMappingsDir: string, taskId: string): string {
  return join(taskMappingsDir, `${taskId}.json`);
}

function getAppliedTaskPath(tasksAppliedDir: string, taskId: string): string {
  return join(tasksAppliedDir, `${taskId}.task.json`);
}

function getAppliedTaskMappingPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.mapping.json`);
}

function getAppliedResultPath(tasksAppliedDir: string, taskId: string): string {
  return join(tasksAppliedDir, `${taskId}.json`);
}

function getTaskIdFromPath(filePath: string): string {
  return basename(filePath, ".json");
}

function toRepoRelativePath(repoDir: string, filePath: string): string {
  return relative(repoDir, filePath);
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
      inProgress: 0,
      done: 0,
      applied: 0,
      invalid: 0,
    },
    tasks: [],
  });
}

async function loadClaimFile(
  filePath: string,
  logger: Logger,
): Promise<NormalizedTaskClaimFile | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return normalizeClaimFile(
      translationTaskClaimFileSchema.parse(await readJson(filePath, {})),
    );
  } catch (error) {
    logger.warn(`Ignoring unreadable claim file ${filePath}: ${String(error)}`);
    return null;
  }
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

async function reclaimExpiredTaskClaims(
  paths: ReturnType<typeof getRepoPaths>,
  logger: Logger,
  options: {
    dropDraft?: boolean;
  } = {},
): Promise<{
  taskIds: string[];
  removedDraftCount: number;
}> {
  const claimFiles = await fg("*.claim.json", {
    cwd: paths.tasksInProgressDir,
    absolute: true,
  });
  const taskIds: string[] = [];
  let removedDraftCount = 0;

  for (const claimPath of claimFiles.sort()) {
    const claim = await loadClaimFile(claimPath, logger);
    if (!claim || !isClaimExpired(claim)) {
      continue;
    }

    await fs.remove(claimPath);
    await fs.remove(getVerificationReportPath(paths, claim.taskId));
    if (options.dropDraft) {
      await fs.remove(getDraftResultPath(paths, claim.taskId));
      removedDraftCount += 1;
    }
    taskIds.push(claim.taskId);
  }

  return {
    taskIds,
    removedDraftCount,
  };
}

function normalizeClaimFile(
  claim: TranslationTaskClaimFile,
): NormalizedTaskClaimFile {
  return {
    ...claim,
    schemaVersion: 2,
    claimId: claim.claimId ?? claim.taskId,
    claimedBy: claim.claimedBy ?? "unknown",
    leaseUntil: claim.leaseUntil ?? claim.claimedAt,
  };
}

function isClaimExpired(
  claim: Pick<NormalizedTaskClaimFile, "leaseUntil">,
  now = new Date(),
): boolean {
  return new Date(claim.leaseUntil).getTime() <= now.getTime();
}

function normalizeLeaseMinutes(leaseMinutes?: number): number {
  if (
    typeof leaseMinutes !== "number" ||
    !Number.isFinite(leaseMinutes) ||
    leaseMinutes <= 0
  ) {
    return DEFAULT_TASK_LEASE_MINUTES;
  }

  return Math.floor(leaseMinutes);
}

async function tryClaimTask(
  repoDir: string,
  paths: ReturnType<typeof getRepoPaths>,
  options: {
    taskId: string;
    workerId: string;
    leaseMinutes: number;
  },
): Promise<ClaimSummary | null> {
  const taskPath = getPendingTaskPath(paths, options.taskId);
  const claimPath = getTaskClaimPath(paths, options.taskId);
  const doneResultPath = getDoneResultPath(paths, options.taskId);
  if (
    !(await fs.pathExists(taskPath)) ||
    (await fs.pathExists(doneResultPath))
  ) {
    return null;
  }

  const task = parseTaskFile(await readJson(taskPath, {}));
  const claimedAt = createTimestamp();
  const leaseUntil = new Date(
    Date.now() + options.leaseMinutes * 60_000,
  ).toISOString();
  const draftResultPath = getDraftResultPath(paths, options.taskId);
  const taskFile = toRepoRelativePath(repoDir, taskPath);
  const draftResultFile = toRepoRelativePath(repoDir, draftResultPath);
  const claim = normalizeClaimFile(
    translationTaskClaimFileSchema.parse({
      schemaVersion: 2,
      taskId: options.taskId,
      claimedAt,
      taskFile,
      draftResultFile,
      claimId: `claim_${nanoid(10)}`,
      claimedBy: options.workerId,
      leaseUntil,
    }),
  );

  let handle;
  try {
    handle = await open(claimPath, "wx");
    await handle.writeFile(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
  } catch (error) {
    await handle?.close();
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return null;
    }

    await fs.remove(claimPath);
    throw error;
  }
  await handle.close();

  if (!(await fs.pathExists(draftResultPath))) {
    await writeJson(draftResultPath, {
      schemaVersion: 2,
      taskId: options.taskId,
      translations: task.content.map((item) => ({
        id: item.id,
        translatedText: "",
      })),
    });
  }

  await fs.remove(getVerificationReportPath(paths, options.taskId));
  return {
    taskId: options.taskId,
    taskFile,
    draftResultFile,
    claimedBy: claim.claimedBy,
    leaseUntil: claim.leaseUntil,
  };
}

async function removePendingTaskBundle(
  paths: ReturnType<typeof getRepoPaths>,
  taskFilePath: string,
  taskId: string,
): Promise<void> {
  await fs.remove(taskFilePath);
  if (taskId) {
    await fs.remove(getTaskMappingPath(paths.taskMappingsDir, taskId));
    await fs.remove(getTaskClaimPath(paths, taskId));
    await fs.remove(getDraftResultPath(paths, taskId));
    await fs.remove(getDoneResultPath(paths, taskId));
    await fs.remove(getVerificationReportPath(paths, taskId));
  }
}

async function archivePendingTaskFile(
  paths: ReturnType<typeof getRepoPaths>,
  taskId: string,
): Promise<void> {
  const pendingTaskPath = getPendingTaskPath(paths, taskId);
  if (!(await fs.pathExists(pendingTaskPath))) {
    return;
  }

  await fs.move(
    pendingTaskPath,
    getAppliedTaskPath(paths.tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
}

async function archiveTaskMapping(
  taskMappingsDir: string,
  tasksAppliedDir: string,
  taskId: string,
): Promise<void> {
  const mappingPath = getTaskMappingPath(taskMappingsDir, taskId);
  if (!(await fs.pathExists(mappingPath))) {
    return;
  }

  await fs.move(
    mappingPath,
    getAppliedTaskMappingPath(tasksAppliedDir, taskId),
    {
      overwrite: true,
    },
  );
}

function isSerializedEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseInlineCodeSpans(
  value: string,
): { textSegments: string[]; inlineCodeSpans: string[] } | null {
  const textSegments: string[] = [];
  const inlineCodeSpans: string[] = [];
  let cursor = 0;
  let textBuffer = "";

  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      textBuffer += value[cursor];
      cursor += 1;
      continue;
    }

    const fenceLength = countBackticks(value, cursor);
    const fence = "`".repeat(fenceLength);
    const contentStart = cursor + fenceLength;
    const contentEnd = value.indexOf(fence, contentStart);
    if (contentEnd < 0) {
      return null;
    }

    textSegments.push(textBuffer);
    textBuffer = "";
    inlineCodeSpans.push(value.slice(contentStart, contentEnd));
    cursor = contentEnd + fenceLength;
  }

  textSegments.push(textBuffer);
  return {
    textSegments,
    inlineCodeSpans,
  };
}

function countBackticks(value: string, startIndex: number): number {
  let length = 0;

  while (value[startIndex + length] === "`") {
    length += 1;
  }

  return length;
}
