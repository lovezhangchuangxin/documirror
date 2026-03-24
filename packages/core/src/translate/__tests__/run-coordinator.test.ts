import { describe, expect, it, vi } from "vitest";

import { runWithCoordinator } from "../services/run-coordinator";

type ConcurrencyMetrics = {
  startedCount: number;
  inFlight: number;
  maxInFlight: number;
  maxConcurrentByPage: Map<string, number>;
  inFlightByPage: Map<string, number>;
};

describe("run coordinator", () => {
  it("borrows spare request slots for chunks when active page count is below concurrency", async () => {
    const metrics = createMetrics();
    const gate = createGate();
    const pages = [
      createPage("task_page_a", 4, gate.promise, metrics),
      createPage("task_page_b", 4, gate.promise, metrics),
    ];

    const runPromise = runWithCoordinator({
      concurrency: 4,
      pages,
    });

    await vi.waitFor(() => {
      expect(metrics.startedCount).toBe(4);
    });

    expect(metrics.maxInFlight).toBe(4);
    expect(metrics.maxConcurrentByPage.get("task_page_a")).toBeGreaterThan(1);
    expect(metrics.maxConcurrentByPage.get("task_page_b")).toBeGreaterThan(1);

    gate.resolve();
    await runPromise;
  });

  it("keeps at most one chunk per active page when page demand fills the budget", async () => {
    const metrics = createMetrics();
    const gate = createGate();
    const pages = [
      createPage("task_page_a", 3, gate.promise, metrics),
      createPage("task_page_b", 3, gate.promise, metrics),
      createPage("task_page_c", 3, gate.promise, metrics),
      createPage("task_page_d", 3, gate.promise, metrics),
      createPage("task_page_e", 3, gate.promise, metrics),
    ];

    const runPromise = runWithCoordinator({
      concurrency: 4,
      pages,
    });

    await vi.waitFor(() => {
      expect(metrics.startedCount).toBe(4);
    });

    expect(metrics.maxInFlight).toBe(4);
    expect(toObject(metrics.maxConcurrentByPage)).toEqual({
      task_page_a: 1,
      task_page_b: 1,
      task_page_c: 1,
      task_page_d: 1,
    });
    expect(metrics.maxConcurrentByPage.has("task_page_e")).toBe(false);

    gate.resolve();
    await runPromise;
    expect(
      metrics.maxConcurrentByPage.get("task_page_e"),
    ).toBeGreaterThanOrEqual(1);
  });
});

function createMetrics(): ConcurrencyMetrics {
  return {
    startedCount: 0,
    inFlight: 0,
    maxInFlight: 0,
    maxConcurrentByPage: new Map(),
    inFlightByPage: new Map(),
  };
}

function createGate(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve,
  };
}

function createPage(
  taskId: string,
  chunkCount: number,
  gate: Promise<void>,
  metrics: ConcurrencyMetrics,
): {
  taskId: string;
  hasPendingChunks(): boolean;
  startNextChunk(): Promise<void>;
  onChunkSettled(): void;
} {
  let nextChunkIndex = 0;

  return {
    taskId,
    hasPendingChunks() {
      return nextChunkIndex < chunkCount;
    },
    async startNextChunk() {
      if (nextChunkIndex >= chunkCount) {
        throw new Error(`No pending chunks left for ${taskId}`);
      }

      nextChunkIndex += 1;
      metrics.startedCount += 1;
      metrics.inFlight += 1;
      metrics.maxInFlight = Math.max(metrics.maxInFlight, metrics.inFlight);

      const pageInFlight = (metrics.inFlightByPage.get(taskId) ?? 0) + 1;
      metrics.inFlightByPage.set(taskId, pageInFlight);
      metrics.maxConcurrentByPage.set(
        taskId,
        Math.max(metrics.maxConcurrentByPage.get(taskId) ?? 0, pageInFlight),
      );

      await gate;

      metrics.inFlight -= 1;
      const nextInFlightForPage = (metrics.inFlightByPage.get(taskId) ?? 1) - 1;
      if (nextInFlightForPage === 0) {
        metrics.inFlightByPage.delete(taskId);
      } else {
        metrics.inFlightByPage.set(taskId, nextInFlightForPage);
      }
    },
    onChunkSettled() {
      // The initial coordinator test surface keeps per-page accounting inside
      // the coordinator; test pages do not need extra state updates here.
    },
  };
}

function toObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}
