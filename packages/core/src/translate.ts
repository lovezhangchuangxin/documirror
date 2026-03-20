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
import { findPendingSegments, markStaleTranslations } from "@documirror/i18n";
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
  defaultLogger,
  hashString,
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
  VerifySummary,
} from "./types";

const VERIFY_REPORT_DIR = "translation-verify";
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

export async function planTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<PlanSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const currentTranslations = await loadTranslations(paths);
  const translations = markStaleTranslations(segments, currentTranslations);
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
      paths.taskMappingsDir,
      paths.tasksPendingDir,
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

export async function claimTranslationTask(
  repoDir: string,
  options: {
    taskId?: string;
  } = {},
  logger: Logger = defaultLogger,
): Promise<ClaimSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const taskManifest = await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  const candidate = options.taskId
    ? taskManifest.tasks.find((task) => task.taskId === options.taskId)
    : taskManifest.tasks.find((task) => task.status === "pending");

  if (!candidate) {
    throw new Error(
      options.taskId
        ? `Task ${options.taskId} was not found in the current translation queue`
        : "No pending translation tasks are available to claim",
    );
  }

  if (candidate.status !== "pending") {
    throw new Error(
      `Task ${candidate.taskId} is ${candidate.status} and cannot be claimed`,
    );
  }

  const task = parseTaskFile(
    await readJson(getPendingTaskPath(paths, candidate.taskId), {}),
  );
  const claimedAt = createTimestamp();
  const draftResultPath = getDraftResultPath(paths, candidate.taskId);
  const taskFile = toRepoRelativePath(
    repoDir,
    getPendingTaskPath(paths, candidate.taskId),
  );

  if (!(await fs.pathExists(draftResultPath))) {
    await writeJson(draftResultPath, {
      schemaVersion: 2,
      taskId: candidate.taskId,
      translations: task.content.map((item) => ({
        id: item.id,
        translatedText: "",
      })),
    });
  }

  await writeJson(
    getTaskClaimPath(paths, candidate.taskId),
    translationTaskClaimFileSchema.parse({
      schemaVersion: 1,
      taskId: candidate.taskId,
      claimedAt,
      taskFile,
      draftResultFile: toRepoRelativePath(repoDir, draftResultPath),
    }),
  );

  await syncTaskManifest(
    repoDir,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    taskId: candidate.taskId,
    taskFile,
    draftResultFile: toRepoRelativePath(repoDir, draftResultPath),
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
  }

  const report = translationVerificationReportSchema.parse({
    schemaVersion: 1,
    taskId,
    checkedAt,
    draftResultFile: toRepoRelativePath(repoDir, draftResultPath),
    draftResultHash,
    ok: issues.length === 0,
    errorCount: issues.length,
    warningCount: warnings.length,
    errors: issues,
    warnings,
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
  taskMappingsDir: string,
  tasksPendingDir: string,
  sourceUrl: string,
  targetLocale: string,
  plannedPages: PlannedPageTask[],
  logger: Logger,
): Promise<RetainPendingTasksResult> {
  const plannedPagesByUrl = new Map(
    plannedPages.map((plannedPage) => [plannedPage.pageUrl, plannedPage]),
  );
  const retainedPageUrls = new Set<string>();
  const files = await fg("*.json", { cwd: tasksPendingDir, absolute: true });
  const invalidatedTaskIds: string[] = [];
  let retainedTaskCount = 0;

  for (const filePath of files.sort()) {
    try {
      const task = parseTaskFile(await readJson(filePath, {}));
      const mapping = await loadRequiredTaskMapping(
        taskMappingsDir,
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
        await removePendingTaskBundle(taskMappingsDir, filePath, task.taskId);
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
      await removePendingTaskBundle(taskMappingsDir, filePath, taskId);
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
        claimedAt: previousEntry?.claimedAt,
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

  return translationTaskManifestEntrySchema.parse({
    taskId: task.taskId,
    page: task.page,
    status: hasDoneResult
      ? "done"
      : claim || hasDraft
        ? "in-progress"
        : "pending",
    contentCount: task.content.length,
    taskFile: toRepoRelativePath(repoDir, taskFilePath),
    draftResultFile:
      claim?.draftResultFile ??
      (hasDraft ? toRepoRelativePath(repoDir, draftResultPath) : undefined),
    doneResultFile: hasDoneResult
      ? toRepoRelativePath(repoDir, doneResultPath)
      : undefined,
    claimedAt: claim?.claimedAt,
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
    const verify =
      task.lastVerifyStatus === undefined
        ? ""
        : ` | verify ${task.lastVerifyStatus}${
            task.lastVerifyErrorCount && task.lastVerifyErrorCount > 0
              ? ` (${task.lastVerifyErrorCount} errors)`
              : ""
          }`;
    lines.push(
      `- ${checkbox} ${task.taskId} | ${task.status} | ${task.contentCount} items${title} | ${task.page.url}${verify}`,
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

  return issues;
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
    translationIndex.set(segmentRef.segmentId, {
      segmentId: segmentRef.segmentId,
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
): Promise<TranslationTaskClaimFile | null> {
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  try {
    return translationTaskClaimFileSchema.parse(await readJson(filePath, {}));
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

async function removePendingTaskBundle(
  taskMappingsDir: string,
  taskFilePath: string,
  taskId: string,
): Promise<void> {
  await fs.remove(taskFilePath);
  if (taskId) {
    await fs.remove(getTaskMappingPath(taskMappingsDir, taskId));
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
