import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getRepoPaths } from "../../repo-paths";
import { ensureRepoStructure, writeJson } from "../../storage";
import {
  archiveDoneResultFile,
  archivePendingTaskFile,
  archiveTaskMapping,
  getAppliedResultHistoryPath,
  getAppliedResultPath,
  getAppliedTaskHistoryPath,
  getAppliedTaskMappingHistoryPath,
  getAppliedTaskMappingPath,
  getAppliedTaskPath,
  getDoneResultPath,
  getPendingTaskPath,
  getRunFailureReportPath,
  getTaskMappingPath,
  getVerificationReportPath,
  listTaskFiles,
  removePendingTaskBundle,
} from "../infra/task-repository";

describe("task repository helpers", () => {
  let repoDir = "";

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "documirror-translate-repo-"));
    await ensureRepoStructure(getRepoPaths(repoDir));
  });

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the task directory is missing", async () => {
    const files = await listTaskFiles(join(repoDir, "missing"), "*.json");

    expect(files).toEqual([]);
  });

  it("removes a pending bundle and all derived artifacts", async () => {
    const paths = getRepoPaths(repoDir);
    const taskId = "task_remove";
    const pendingPath = getPendingTaskPath(paths, taskId);
    const mappingPath = getTaskMappingPath(paths.taskMappingsDir, taskId);
    const donePath = getDoneResultPath(paths, taskId);
    const verifyPath = getVerificationReportPath(paths, taskId);
    const runFailurePath = getRunFailureReportPath(paths, taskId);

    await Promise.all([
      writeJson(pendingPath, {}),
      writeJson(mappingPath, {}),
      writeJson(donePath, {}),
      writeJson(verifyPath, {}),
      writeJson(runFailurePath, {}),
    ]);

    await removePendingTaskBundle(paths, pendingPath, taskId);

    await expect(fs.pathExists(pendingPath)).resolves.toBe(false);
    await expect(fs.pathExists(mappingPath)).resolves.toBe(false);
    await expect(fs.pathExists(donePath)).resolves.toBe(false);
    await expect(fs.pathExists(verifyPath)).resolves.toBe(false);
    await expect(fs.pathExists(runFailurePath)).resolves.toBe(false);
  });

  it("archives task, mapping, and result files into applied and history paths", async () => {
    const paths = getRepoPaths(repoDir);
    const taskId = "task_archive";
    const archiveStamp = "2026-03-21T00-00-00-000Z";
    const pendingPath = getPendingTaskPath(paths, taskId);
    const mappingPath = getTaskMappingPath(paths.taskMappingsDir, taskId);
    const donePath = getDoneResultPath(paths, taskId);

    await Promise.all([
      writeFile(pendingPath, "pending\n", "utf8"),
      writeFile(mappingPath, "mapping\n", "utf8"),
      writeFile(donePath, "result\n", "utf8"),
    ]);

    await archivePendingTaskFile(paths, taskId, archiveStamp);
    await archiveTaskMapping(taskId, paths, archiveStamp);
    await archiveDoneResultFile(paths, taskId, donePath, archiveStamp);

    const appliedTaskPath = getAppliedTaskPath(paths.tasksAppliedDir, taskId);
    const appliedMappingPath = getAppliedTaskMappingPath(
      paths.tasksAppliedDir,
      taskId,
    );
    const appliedResultPath = getAppliedResultPath(
      paths.tasksAppliedDir,
      taskId,
    );
    const taskHistoryPath = getAppliedTaskHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    );
    const mappingHistoryPath = getAppliedTaskMappingHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    );
    const resultHistoryPath = getAppliedResultHistoryPath(
      paths.tasksAppliedHistoryDir,
      taskId,
      archiveStamp,
    );

    await expect(fs.pathExists(pendingPath)).resolves.toBe(false);
    await expect(fs.pathExists(mappingPath)).resolves.toBe(false);
    await expect(fs.pathExists(donePath)).resolves.toBe(false);
    await expect(readFile(appliedTaskPath, "utf8")).resolves.toBe("pending\n");
    await expect(readFile(appliedMappingPath, "utf8")).resolves.toBe(
      "mapping\n",
    );
    await expect(readFile(appliedResultPath, "utf8")).resolves.toBe("result\n");
    await expect(readFile(taskHistoryPath, "utf8")).resolves.toBe("pending\n");
    await expect(readFile(mappingHistoryPath, "utf8")).resolves.toBe(
      "mapping\n",
    );
    await expect(readFile(resultHistoryPath, "utf8")).resolves.toBe("result\n");
  });
});
