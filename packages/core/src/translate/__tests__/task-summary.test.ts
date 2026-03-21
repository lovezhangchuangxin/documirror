import { describe, expect, it } from "vitest";

import type { TranslationTaskManifestEntry } from "@documirror/shared";

import {
  buildInvalidManifestEntry,
  createTaskManifestSummary,
  renderTaskQueueBoard,
} from "../domain/task-summary";

const baseEntry: TranslationTaskManifestEntry = {
  taskId: "task-1",
  page: { url: "https://docs.example.com/", title: "Docs" },
  status: "pending",
  contentCount: 3,
  taskFile: ".documirror/tasks/pending/task-1.json",
};

describe("task summary helpers", () => {
  it("summarizes task statuses", () => {
    const tasks: TranslationTaskManifestEntry[] = [
      baseEntry,
      { ...baseEntry, taskId: "task-2", status: "done" },
      { ...baseEntry, taskId: "task-3", status: "applied" },
      { ...baseEntry, taskId: "task-4", status: "invalid" },
    ];

    expect(createTaskManifestSummary(tasks)).toEqual({
      total: 4,
      pending: 1,
      done: 1,
      applied: 1,
      invalid: 1,
    });
  });

  it("renders queue information and keeps previous metadata for invalid entries", () => {
    const invalidEntry = buildInvalidManifestEntry({
      taskId: "task-2",
      taskFile: ".documirror/tasks/pending/task-2.json",
      previousEntry: {
        ...baseEntry,
        taskId: "task-2",
        status: "done",
        doneResultFile: ".documirror/tasks/done/task-2.json",
        completedAt: "2026-03-21T00:00:00.000Z",
        provider: "openai",
        model: "gpt-4.1-mini",
        lastVerifyStatus: "fail",
        lastVerifyErrorCount: 2,
        lastRunStatus: "fail",
        lastRunError: "schema mismatch",
      },
    });
    const manifest = {
      schemaVersion: 1 as const,
      generatedAt: "2026-03-21T00:00:00.000Z",
      sourceUrl: "https://docs.example.com/",
      targetLocale: "zh-CN",
      summary: {
        total: 2,
        pending: 1,
        done: 0,
        applied: 0,
        invalid: 1,
      },
      tasks: [baseEntry, invalidEntry],
    };

    const board = renderTaskQueueBoard(manifest);

    expect(invalidEntry.doneResultFile).toBe(
      ".documirror/tasks/done/task-2.json",
    );
    expect(board).toContain("task-2 | invalid");
    expect(board).toContain("verify fail (2 errors)");
    expect(board).toContain("last run failed: schema mismatch");
  });
});
