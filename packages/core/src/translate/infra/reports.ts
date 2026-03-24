import fs from "fs-extra";

import type { Logger, TranslationVerificationReport } from "@documirror/shared";
import {
  createTimestamp,
  hashString,
  translationVerificationReportSchema,
} from "@documirror/shared";

import type { RepoPaths } from "../../types";
import type {
  CandidateVerification,
  RunFailureReport,
} from "../internal-types";
import { readJson, writeJson } from "../../storage";
import {
  getRunFailureReportPath,
  getVerificationReportPath,
  toRepoRelativePath,
} from "./task-repository";

export async function loadVerificationReport(
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

export async function loadRunFailureReport(
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

export function createVerificationReport(options: {
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

export async function writeVerificationReport(
  repoDir: string,
  paths: RepoPaths,
  taskId: string,
  resultPath: string,
  resultBody: string,
  verification: CandidateVerification,
): Promise<void> {
  await writeJson(
    getVerificationReportPath(paths, taskId),
    createVerificationReport({
      repoDir,
      taskId,
      resultPath,
      resultBody,
      verification,
    }),
  );
}

export async function writeRunFailureReport(
  paths: RepoPaths,
  report: RunFailureReport,
): Promise<void> {
  await writeJson(getRunFailureReportPath(paths, report.taskId), report);
}
