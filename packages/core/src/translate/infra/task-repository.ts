import fg from "fast-glob";
import fs from "fs-extra";
import { basename, dirname, join, relative } from "pathe";

import {
  parseResultFile,
  parseTaskFile,
  parseTaskMappingFile,
} from "@documirror/adapters-filequeue";
import type {
  Logger,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskManifest,
  TranslationTaskMappingFile,
} from "@documirror/shared";
import {
  createTimestamp,
  translationTaskManifestSchema,
} from "@documirror/shared";

import type { RepoPaths } from "../../types";
import { readJson } from "../../storage";

export function getPendingTaskPath(paths: RepoPaths, taskId: string): string {
  return join(paths.tasksPendingDir, `${taskId}.json`);
}

export function getDoneResultPath(paths: RepoPaths, taskId: string): string {
  return join(paths.tasksDoneDir, `${taskId}.json`);
}

export function getVerificationReportPath(
  paths: RepoPaths,
  taskId: string,
): string {
  return join(paths.reportsDir, "translation-verify", `${taskId}.json`);
}

export function getRunFailureReportPath(
  paths: RepoPaths,
  taskId: string,
): string {
  return join(paths.reportsDir, "translation-run", `${taskId}.json`);
}

export function getTaskMappingPath(
  taskMappingsDir: string,
  taskId: string,
): string {
  return join(taskMappingsDir, `${taskId}.json`);
}

export function getAppliedTaskPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.task.json`);
}

export function getAppliedTaskHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(tasksAppliedHistoryDir, `${taskId}--${archiveStamp}.task.json`);
}

export function getAppliedTaskMappingPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.mapping.json`);
}

export function getAppliedTaskMappingHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(
    tasksAppliedHistoryDir,
    `${taskId}--${archiveStamp}.mapping.json`,
  );
}

export function getAppliedResultPath(
  tasksAppliedDir: string,
  taskId: string,
): string {
  return join(tasksAppliedDir, `${taskId}.json`);
}

export function getAppliedResultHistoryPath(
  tasksAppliedHistoryDir: string,
  taskId: string,
  archiveStamp: string,
): string {
  return join(tasksAppliedHistoryDir, `${taskId}--${archiveStamp}.json`);
}

export function getTaskIdFromPath(filePath: string): string {
  return basename(filePath, ".json");
}

export function toRepoRelativePath(repoDir: string, filePath: string): string {
  return relative(repoDir, filePath);
}

export async function listTaskFiles(
  directory: string,
  pattern: string,
): Promise<string[]> {
  if (!(await fs.pathExists(directory))) {
    return [];
  }

  return (
    await fg(pattern, {
      cwd: directory,
      absolute: true,
      onlyFiles: true,
    })
  ).sort();
}

export async function loadTaskArtifacts(
  paths: RepoPaths,
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

export async function loadRequiredTaskMapping(
  taskMappingsDir: string,
  taskId: string,
): Promise<TranslationTaskMappingFile> {
  return parseTaskMappingFile(
    await readJson(getTaskMappingPath(taskMappingsDir, taskId), {}),
  );
}

export async function loadTaskMapping(
  taskMappingsDir: string,
  taskId: string,
): Promise<TranslationTaskMappingFile | null> {
  try {
    return await loadRequiredTaskMapping(taskMappingsDir, taskId);
  } catch {
    return null;
  }
}

export async function loadTaskManifest(
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

export function createEmptyTaskManifest(
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

export async function loadResultFile(
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

export async function removePendingTaskBundle(
  paths: RepoPaths,
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

export function createArchiveStamp(timestamp: string): string {
  return timestamp.replace(/[:.]/gu, "-");
}

export async function archivePendingTaskFile(
  paths: RepoPaths,
  taskId: string,
  archiveStamp: string,
): Promise<void> {
  const pendingTaskPath = getPendingTaskPath(paths, taskId);
  if (!(await fs.pathExists(pendingTaskPath))) {
    return;
  }

  const appliedTaskPath = getAppliedTaskPath(paths.tasksAppliedDir, taskId);
  const appliedTaskHistoryPath = getAppliedTaskHistoryPath(
    paths.tasksAppliedHistoryDir,
    taskId,
    archiveStamp,
  );
  await fs.ensureDir(dirname(appliedTaskPath));
  await fs.ensureDir(dirname(appliedTaskHistoryPath));
  await fs.move(pendingTaskPath, appliedTaskPath, {
    overwrite: true,
  });
  await fs.copy(appliedTaskPath, appliedTaskHistoryPath, {
    overwrite: true,
  });
}

export async function archiveTaskMapping(
  taskId: string,
  paths: RepoPaths,
  archiveStamp: string,
): Promise<void> {
  const mappingPath = getTaskMappingPath(paths.taskMappingsDir, taskId);
  if (!(await fs.pathExists(mappingPath))) {
    return;
  }

  const appliedMappingPath = getAppliedTaskMappingPath(
    paths.tasksAppliedDir,
    taskId,
  );
  const appliedTaskMappingHistoryPath = getAppliedTaskMappingHistoryPath(
    paths.tasksAppliedHistoryDir,
    taskId,
    archiveStamp,
  );
  await fs.ensureDir(dirname(appliedMappingPath));
  await fs.ensureDir(dirname(appliedTaskMappingHistoryPath));
  await fs.move(mappingPath, appliedMappingPath, {
    overwrite: true,
  });
  await fs.copy(appliedMappingPath, appliedTaskMappingHistoryPath, {
    overwrite: true,
  });
}

export function isSerializedEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function parseCandidateResult(body: string): TranslationResultFile {
  return parseResultFile(JSON.parse(body));
}

export async function archiveDoneResultFile(
  paths: RepoPaths,
  taskId: string,
  resultPath: string,
  archiveStamp: string,
): Promise<void> {
  if (!(await fs.pathExists(resultPath))) {
    return;
  }

  const appliedResultPath = getAppliedResultPath(paths.tasksAppliedDir, taskId);
  const appliedResultHistoryPath = getAppliedResultHistoryPath(
    paths.tasksAppliedHistoryDir,
    taskId,
    archiveStamp,
  );
  await fs.ensureDir(dirname(appliedResultPath));
  await fs.ensureDir(dirname(appliedResultHistoryPath));
  await fs.move(resultPath, appliedResultPath, {
    overwrite: true,
  });
  await fs.copy(appliedResultPath, appliedResultHistoryPath, {
    overwrite: true,
  });
}
