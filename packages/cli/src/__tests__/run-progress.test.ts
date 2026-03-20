import { describe, expect, it } from "vitest";

import {
  applyRunProgressEvent,
  createRunProgressState,
  formatRunProgressMessage,
} from "../run-progress";

// Strip ANSI color codes for testing
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/gu, "");
}

describe("run translation progress formatting", () => {
  it("shows active tasks, model metadata, and elapsed wait time", () => {
    const state = createRunProgressState(0);

    applyRunProgressEvent(
      state,
      {
        type: "queued",
        total: 3,
        concurrency: 2,
        provider: "openai",
        model: "gpt-4.1-mini",
        requestTimeoutMs: 60_000,
      },
      0,
    );
    applyRunProgressEvent(
      state,
      {
        type: "started",
        taskId: "task_alpha",
        completed: 0,
        total: 3,
      },
      500,
    );
    applyRunProgressEvent(
      state,
      {
        type: "attempt",
        taskId: "task_alpha",
        attempt: 1,
        maxAttempts: 3,
        completed: 0,
        total: 3,
      },
      1_000,
    );

    expect(formatRunProgressMessage(state, 31_000)).toContain(
      "0/3 complete, 0 succeeded, 0 failed, 1 running, 2 waiting",
    );
    expect(formatRunProgressMessage(state, 31_000)).toContain(
      "model openai/gpt-4.1-mini, concurrency 2, timeout 60s, elapsed 31s",
    );
    expect(stripAnsi(formatRunProgressMessage(state, 31_000))).toContain(
      "[task_alpha] attempt 1/3, waiting 30s",
    );
  });

  it("removes completed tasks from the waiting summary", () => {
    const state = createRunProgressState(0);

    applyRunProgressEvent(
      state,
      {
        type: "queued",
        total: 1,
        concurrency: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        requestTimeoutMs: 60_000,
      },
      0,
    );
    applyRunProgressEvent(
      state,
      {
        type: "attempt",
        taskId: "task_alpha",
        attempt: 1,
        maxAttempts: 3,
        completed: 0,
        total: 1,
      },
      1_000,
    );
    applyRunProgressEvent(
      state,
      {
        type: "completed",
        taskId: "task_alpha",
        completed: 1,
        total: 1,
        successCount: 1,
        failureCount: 0,
      },
      5_000,
    );

    const message = formatRunProgressMessage(state, 5_000);
    expect(message).toContain(
      "1/1 complete, 1 succeeded, 0 failed, 0 running, 0 waiting",
    );
    expect(message).not.toContain("[task_alpha]");
  });

  it("marks active attempts that have exceeded the configured timeout", () => {
    const state = createRunProgressState(0);

    applyRunProgressEvent(
      state,
      {
        type: "queued",
        total: 1,
        concurrency: 1,
        provider: "openai",
        model: "gpt-4.1-mini",
        requestTimeoutMs: 60_000,
      },
      0,
    );
    applyRunProgressEvent(
      state,
      {
        type: "attempt",
        taskId: "task_alpha",
        attempt: 1,
        maxAttempts: 3,
        completed: 0,
        total: 1,
      },
      1_000,
    );

    expect(stripAnsi(formatRunProgressMessage(state, 62_000))).toContain(
      "[task_alpha] attempt 1/3, waiting 1m 1s ⚠ past timeout",
    );
  });
});
