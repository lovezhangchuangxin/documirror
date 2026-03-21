import fs from "fs-extra";

import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "../../repo-paths";
import { loadConfig, loadSegments } from "../../storage";
import type { VerifySummary } from "../../types";
import {
  createIssuesFromUnknownError,
  verifyCandidateResult,
} from "../domain/verification";
import {
  getDoneResultPath,
  loadTaskArtifacts,
  parseCandidateResult,
  toRepoRelativePath,
} from "../infra/task-repository";
import { getVerificationReportPath } from "../infra/task-repository";
import { writeVerificationReport } from "../infra/reports";
import { syncTaskManifest } from "../services/task-manifest";

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
  let verification;
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

  await writeVerificationReport(
    repoDir,
    paths,
    taskId,
    resultPath,
    resultBody,
    verification,
  );
  const reportPath = getVerificationReportPath(paths, taskId);

  await syncTaskManifest(
    repoDir,
    paths,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
  return {
    taskId,
    ok: verification.ok,
    reportPath: toRepoRelativePath(repoDir, reportPath),
    errorCount: verification.errors.length,
    warningCount: verification.warnings.length,
    errors: verification.errors,
    warnings: verification.warnings,
  };
}
