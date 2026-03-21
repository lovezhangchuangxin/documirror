import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Logger, SegmentRecord } from "@documirror/shared";

import { getRepoPaths } from "../../repo-paths";
import { ensureRepoStructure, writeJson } from "../../storage";
import {
  getPendingTaskPath,
  getTaskMappingPath,
} from "../infra/task-repository";
import { prepareApplyTaskBundle } from "../services/task-applier";

describe("task applier", () => {
  let repoDir = "";

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "documirror-translate-apply-"));
    await ensureRepoStructure(getRepoPaths(repoDir));
  });

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it("rejects stale done results before apply", async () => {
    const paths = getRepoPaths(repoDir);
    const taskId = "task_stale_apply";
    const warnings: string[] = [];
    const logger: Logger = {
      info() {},
      warn(message) {
        warnings.push(message);
      },
      error() {},
    };

    await writeJson(getPendingTaskPath(paths, taskId), {
      schemaVersion: 2,
      taskId,
      sourceUrl: "https://docs.example.com/",
      targetLocale: "zh-CN",
      createdAt: "2026-03-21T00:00:00.000Z",
      instructions: {
        translateTo: "zh-CN",
        preserveFormatting: true,
        preservePlaceholders: true,
        preserveInlineCode: true,
        applyGlossary: true,
        noOmission: true,
        noAddition: true,
      },
      glossary: [],
      page: {
        url: "https://docs.example.com/",
      },
      content: [{ id: "1", text: "Install" }],
    });
    await writeJson(getTaskMappingPath(paths.taskMappingsDir, taskId), {
      schemaVersion: 2,
      taskId,
      sourceUrl: "https://docs.example.com/",
      targetLocale: "zh-CN",
      createdAt: "2026-03-21T00:00:00.000Z",
      page: {
        url: "https://docs.example.com/",
      },
      items: [
        {
          id: "1",
          kind: "segment",
          segment: {
            segmentId: "seg-1",
            sourceHash: "old-hash",
          },
        },
      ],
    });
    const resultPath = join(paths.tasksDoneDir, `${taskId}.json`);
    await writeJson(resultPath, {
      schemaVersion: 2,
      taskId,
      provider: "openai",
      model: "gpt-4.1-mini",
      completedAt: "2026-03-21T00:00:00.000Z",
      translations: [{ id: "1", translatedText: "安装" }],
    });

    const segmentIndex = new Map<string, SegmentRecord>([
      [
        "seg-1",
        {
          segmentId: "seg-1",
          pageUrl: "https://docs.example.com/",
          domPath: "body.p[1]",
          kind: "text",
          sourceText: "Install",
          normalizedText: "Install",
          sourceHash: "new-hash",
          context: {
            tagName: "p",
          },
        },
      ],
    ]);

    const bundle = await prepareApplyTaskBundle({
      filePath: resultPath,
      paths,
      segmentIndex,
      logger,
    });

    expect(bundle).toBeNull();
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `Skipping result import for ${taskId} because verification failed`,
        ),
        expect.stringContaining("[task_stale]"),
      ]),
    );
  });
});
