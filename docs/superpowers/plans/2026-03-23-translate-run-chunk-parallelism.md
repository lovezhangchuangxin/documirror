# Translate Run Chunk Parallelism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `documirror translate run` execute runtime chunks in parallel when page-level concurrency leaves spare capacity, while preserving page-based persistence, retries, and apply behavior.

**Architecture:** Introduce a page-aware run coordinator that owns the single global `ai.concurrency` budget and schedules chunk requests with page-first priority. Refactor task running into page-session preparation, single-chunk execution, and page finalization so chunk requests can be interleaved safely across pages without changing persisted task or result contracts.

**Tech Stack:** TypeScript, Node.js 20+, Vitest, `p-limit` replacement via explicit coordinator logic, existing OpenAI adapter and CLI progress renderer

---

## Spec Reference

- Design spec: `docs/superpowers/specs/2026-03-23-translate-run-chunk-parallelism-design.md`

## File Structure

- Create: `packages/core/src/translate/services/run-coordinator.ts`
  - Own the global request budget, page activation, spare-slot chunk fan-out, and completion accounting.
- Modify: `packages/core/src/translate/commands/run.ts`
  - Replace outer `p-limit` page scheduling with the coordinator.
- Modify: `packages/core/src/translate/services/task-runner.ts`
  - Split page work into session preparation, one-chunk execution, and page finalization helpers.
- Modify: `packages/core/src/translate/internal-types.ts`
  - Add coordinator-facing page session, chunk result, and failure aggregation types.
- Modify: `packages/core/src/page-chunking.ts`
  - Make chunk merge order-independent by sorting by `chunkIndex`.
- Modify: `packages/core/src/types.ts`
  - Extend progress events with `activityId` and `pageTaskId`.
- Modify: `packages/core/src/translate/infra/reports.ts`
  - Add page-level aggregated chunk failure report writing and backward-compatible loading.
- Modify: `packages/core/src/translate/services/task-manifest.ts`
  - Keep manifest sync compatible with updated run failure reports.
- Modify: `packages/cli/src/run-progress.ts`
  - Track concurrent chunk activity by `activityId` instead of `taskId`.
- Test: `packages/core/src/translate/__tests__/run-coordinator.test.ts`
  - Unit-test dispatch rules independently from OpenAI calls.
- Test: `packages/core/src/__tests__/core.test.ts`
  - Integration coverage for chunk borrowing, retry isolation, out-of-order completion, and aggregated failure reports.
- Test: `packages/cli/src/__tests__/run-progress.test.ts`
  - CLI rendering for multiple in-flight chunks from one page.
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/templates/src/task-guide.ts`

### Task 1: Add A Unit-Tested Run Coordinator

**Files:**

- Create: `packages/core/src/translate/services/run-coordinator.ts`
- Create: `packages/core/src/translate/__tests__/run-coordinator.test.ts`
- Modify: `packages/core/src/translate/internal-types.ts`

- [ ] **Step 1: Write the failing coordinator scheduling tests**

```ts
import { describe, expect, it } from "vitest";

import { runWithCoordinator } from "../services/run-coordinator";

it("borrows spare request slots for chunks when active page count is below concurrency", async () => {
  const events: string[] = [];

  await runWithCoordinator({
    concurrency: 4,
    pages: [
      createPage("task_page_a", 4, events),
      createPage("task_page_b", 4, events),
    ],
  });

  expect(maxInFlight(events)).toBe(4);
  expect(maxConcurrentForPage(events, "task_page_a")).toBeGreaterThan(1);
  expect(maxConcurrentForPage(events, "task_page_b")).toBeGreaterThan(1);
});

it("keeps at most one chunk per active page when page demand fills the budget", async () => {
  const events: string[] = [];

  await runWithCoordinator({
    concurrency: 4,
    pages: [
      createPage("task_page_a", 3, events),
      createPage("task_page_b", 3, events),
      createPage("task_page_c", 3, events),
      createPage("task_page_d", 3, events),
      createPage("task_page_e", 3, events),
    ],
  });

  expect(maxInFlight(events)).toBe(4);
  expect(maxConcurrentPerPage(events)).toEqual({
    task_page_a: 1,
    task_page_b: 1,
    task_page_c: 1,
    task_page_d: 1,
    task_page_e: 1,
  });
});
```

- [ ] **Step 2: Run the coordinator tests to verify they fail**

Run: `pnpm test -- packages/core/src/translate/__tests__/run-coordinator.test.ts`

Expected: FAIL because `run-coordinator.ts` and its exported scheduler entrypoint do not exist yet.

- [ ] **Step 3: Implement the minimal coordinator surface**

```ts
export type CoordinatorPage = {
  taskId: string;
  hasPendingChunks(): boolean;
  startNextChunk(): Promise<void>;
  onChunkSettled(): void;
};

export async function runWithCoordinator(options: {
  concurrency: number;
  pages: CoordinatorPage[];
}): Promise<void> {
  // Page-first activation:
  // 1. start new pages until activePages.size === concurrency
  // 2. only borrow spare slots when activePages.size < concurrency
  // 3. round-robin across active pages for extra chunks
}
```

- [ ] **Step 4: Re-run the coordinator tests**

Run: `pnpm test -- packages/core/src/translate/__tests__/run-coordinator.test.ts`

Expected: PASS for the two dispatch-rule tests.

- [ ] **Step 5: Commit the coordinator scaffold**

```bash
git add packages/core/src/translate/services/run-coordinator.ts packages/core/src/translate/__tests__/run-coordinator.test.ts packages/core/src/translate/internal-types.ts
git commit -m "feat(core): add translate run coordinator"
```

### Task 2: Refactor Page Runs Into Session Preparation, Chunk Execution, And Finalization

**Files:**

- Modify: `packages/core/src/translate/services/task-runner.ts`
- Modify: `packages/core/src/page-chunking.ts`
- Modify: `packages/core/src/translate/internal-types.ts`
- Test: `packages/core/src/__tests__/core.test.ts`

- [ ] **Step 1: Write the failing integration test for out-of-order chunk completion**

```ts
it("merges chunk drafts by chunk index instead of completion order", async () => {
  const deferreds = createChunkDeferreds([
    "task_dc3d488a4e__chunk_1",
    "task_dc3d488a4e__chunk_2",
  ]);

  mockTranslateTaskWithOpenAi.mockImplementation(
    ({ task }) => deferreds.get(task.taskId)!.promise,
  );

  const runPromise = runTranslations(repoDir, silentLogger);

  deferreds.get("task_dc3d488a4e__chunk_2")!.resolve(chunkTwoResult);
  deferreds.get("task_dc3d488a4e__chunk_1")!.resolve(chunkOneResult);

  await runPromise;

  expect(
    readDoneResult(repoDir, "task_dc3d488a4e").translations.map(
      (item) => item.id,
    ),
  ).toEqual(["1", "2", "3", "4", "5", "6"]);
});
```

- [ ] **Step 2: Run the targeted integration test and confirm it fails**

Run: `pnpm test -- packages/core/src/__tests__/core.test.ts -t "merges chunk drafts by chunk index instead of completion order"`

Expected: FAIL because merge order still depends on completion order or because the run cannot interleave chunk completion yet.

- [ ] **Step 3: Refactor `task-runner.ts` into session lifecycle helpers**

```ts
export async function prepareTaskRunSession(...): Promise<PageTaskRunSession> {
  // load task + mapping
  // validate freshness
  // plan chunks
}

export async function runPreparedTaskChunk(...): Promise<ChunkExecutionResult> {
  // current runTaskView logic with per-chunk retry
}

export async function finalizeTaskRunSession(...): Promise<void> {
  // sort chunk drafts by chunkIndex
  // merge
  // verify final page result
  // write done result + verification report
}
```

- [ ] **Step 4: Update `mergeChunkDrafts()` to sort by `chunk.chunkIndex` before flattening**

```ts
const orderedChunkDrafts = [...options.chunkDrafts].sort(
  (left, right) => left.chunk.chunkIndex - right.chunk.chunkIndex,
);
```

- [ ] **Step 5: Re-run the targeted integration test**

Run: `pnpm test -- packages/core/src/__tests__/core.test.ts -t "merges chunk drafts by chunk index instead of completion order"`

Expected: PASS, with the final result still written as one page-level file.

- [ ] **Step 6: Commit the session refactor**

```bash
git add packages/core/src/translate/services/task-runner.ts packages/core/src/page-chunking.ts packages/core/src/translate/internal-types.ts packages/core/src/__tests__/core.test.ts
git commit -m "refactor(core): split translate task run lifecycle"
```

### Task 3: Wire The Coordinator Into `runTranslations`

**Files:**

- Modify: `packages/core/src/translate/commands/run.ts`
- Modify: `packages/core/src/translate/services/task-runner.ts`
- Modify: `packages/core/src/translate/internal-types.ts`
- Test: `packages/core/src/__tests__/core.test.ts`

- [ ] **Step 1: Write the failing integration test for spare-slot chunk borrowing**

```ts
it("uses spare concurrency slots for chunks when fewer pages are active than the budget", async () => {
  let inFlight = 0;
  let maxInFlight = 0;

  mockTranslateTaskWithOpenAi.mockImplementation(async ({ task }) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await waitForGate(task.taskId);
    inFlight -= 1;
    return buildValidChunkResult(task);
  });

  await runTranslations(repoDirWithTwoPendingPagesAndChunking, silentLogger);

  expect(maxInFlight).toBe(4);
});
```

- [ ] **Step 2: Write the failing integration test for page-first scheduling**

```ts
it("limits active pages to one in-flight chunk each when page demand fills concurrency", async () => {
  const maxConcurrentByPage = new Map<string, number>();

  mockTranslateTaskWithOpenAi.mockImplementation(async ({ task }) => {
    recordPageConcurrency(task.taskId, maxConcurrentByPage);
    await waitForGate(task.taskId);
    return buildValidChunkResult(task);
  });

  await runTranslations(repoDirWithFivePendingPagesAndChunking, silentLogger);

  expect([...maxConcurrentByPage.values()]).toEqual([1, 1, 1, 1, 1]);
});
```

- [ ] **Step 3: Run the targeted core tests and confirm they fail**

Run: `pnpm test -- packages/core/src/__tests__/core.test.ts -t "uses spare concurrency slots for chunks when fewer pages are active than the budget|limits active pages to one in-flight chunk each when page demand fills concurrency"`

Expected: FAIL because `runTranslations()` still uses outer page-only `p-limit` scheduling.

- [ ] **Step 4: Replace the outer `p-limit` loop with the coordinator**

```ts
const summary = await runTranslationCoordinator({
  pendingTasks,
  concurrency: config.ai.concurrency,
  preparePage: (taskId) => prepareTaskRunSession(...),
  runChunk: (page, chunkIndex) => runPreparedTaskChunk(...),
  finalizePage: (page) => finalizeTaskRunSession(...),
  onProgress,
  signal,
});
```

- [ ] **Step 5: Re-run the targeted coordinator integration tests**

Run: `pnpm test -- packages/core/src/__tests__/core.test.ts -t "uses spare concurrency slots for chunks when fewer pages are active than the budget|limits active pages to one in-flight chunk each when page demand fills concurrency"`

Expected: PASS, with `maxInFlight === 4` in the two-page case and `maxConcurrentByPage === 1` when four or more pages are queued.

- [ ] **Step 6: Commit the coordinator integration**

```bash
git add packages/core/src/translate/commands/run.ts packages/core/src/translate/services/task-runner.ts packages/core/src/translate/internal-types.ts packages/core/src/__tests__/core.test.ts
git commit -m "feat(core): parallelize translate run chunks"
```

### Task 4: Make Progress And Failure Reporting Chunk-Safe

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/translate/infra/reports.ts`
- Modify: `packages/core/src/translate/services/task-runner.ts`
- Modify: `packages/core/src/translate/services/task-manifest.ts`
- Modify: `packages/cli/src/run-progress.ts`
- Test: `packages/core/src/__tests__/core.test.ts`
- Test: `packages/cli/src/__tests__/run-progress.test.ts`

- [ ] **Step 1: Write the failing CLI progress test for multiple active chunks on one page**

```ts
it("tracks chunk activities by activityId so one page can show multiple in-flight rows", () => {
  const state = createRunProgressState();

  applyRunProgressEvent(state, {
    type: "attempt",
    taskId: "task_alpha",
    pageTaskId: "task_alpha",
    activityId: "task_alpha__chunk_1",
    attempt: 1,
    maxAttempts: 3,
    completed: 0,
    total: 1,
    chunk: { chunkIndex: 1, chunkCount: 3, itemStart: 1, itemEnd: 80 },
  });

  applyRunProgressEvent(state, {
    type: "attempt",
    taskId: "task_alpha",
    pageTaskId: "task_alpha",
    activityId: "task_alpha__chunk_2",
    attempt: 1,
    maxAttempts: 3,
    completed: 0,
    total: 1,
    chunk: { chunkIndex: 2, chunkCount: 3, itemStart: 81, itemEnd: 140 },
  });

  expect(state.activeTasks.size).toBe(2);
});
```

- [ ] **Step 2: Write the failing integration test for aggregated page-level failure reports**

```ts
it("writes one page-level run report with chunk details when parallel chunks fail", async () => {
  mockTranslateTaskWithOpenAi.mockImplementation(({ task }) => {
    if (
      task.taskId.endsWith("__chunk_1") ||
      task.taskId.endsWith("__chunk_2")
    ) {
      throw new Error(`simulated failure for ${task.taskId}`);
    }
    return Promise.resolve(buildValidChunkResult(task));
  });

  await expect(runTranslations(repoDir, silentLogger)).rejects.toThrow();

  const report = readRunFailureReport(repoDir, "task_dc3d488a4e");
  expect(report.taskId).toBe("task_dc3d488a4e");
  expect(report.chunks).toHaveLength(2);
  expect(report.chunks.map((chunk) => chunk.chunkId)).toEqual([
    "task_dc3d488a4e__chunk_1",
    "task_dc3d488a4e__chunk_2",
  ]);
});
```

- [ ] **Step 3: Run the targeted progress and report tests to verify they fail**

Run: `pnpm test -- packages/cli/src/__tests__/run-progress.test.ts packages/core/src/__tests__/core.test.ts -t "tracks chunk activities by activityId|writes one page-level run report with chunk details"`

Expected: FAIL because active tasks are still keyed by page `taskId`, and chunk workers still compete to write the same page-level run report.

- [ ] **Step 4: Extend progress events and update CLI state to use `activityId`**

```ts
type RunTranslationsProgressEvent = {
  type: "attempt";
  taskId: string;
  pageTaskId: string;
  activityId: string;
  attempt: number;
  maxAttempts: number;
  completed: number;
  total: number;
  chunk?: RunTaskChunkProgress;
};
```

- [ ] **Step 5: Aggregate chunk failures in memory and write one page report on page completion**

```ts
await writeRunFailureReport(paths, taskId, {
  schemaVersion: 2,
  taskId,
  failedAt: createTimestamp(),
  attemptCount: pageAttemptCount,
  message: fatalError.message,
  errors: [],
  chunks: chunkFailures,
});
```

- [ ] **Step 6: Keep `task-manifest.ts` tolerant of both legacy and aggregated reports**

Run: `pnpm test -- packages/cli/src/__tests__/run-progress.test.ts packages/core/src/__tests__/core.test.ts -t "tracks chunk activities by activityId|writes one page-level run report with chunk details"`

Expected: PASS, with CLI showing two active rows for one page and manifest sync still reading top-level failure metadata.

- [ ] **Step 7: Commit progress and report safety changes**

```bash
git add packages/core/src/types.ts packages/core/src/translate/infra/reports.ts packages/core/src/translate/services/task-runner.ts packages/core/src/translate/services/task-manifest.ts packages/cli/src/run-progress.ts packages/core/src/__tests__/core.test.ts packages/cli/src/__tests__/run-progress.test.ts
git commit -m "fix(cli): support concurrent chunk progress"
```

### Task 5: Preserve Retry Isolation, Update Docs, And Run Full Validation

**Files:**

- Modify: `packages/core/src/__tests__/core.test.ts`
- Modify: `README.md`
- Modify: `README.zh.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/templates/src/task-guide.ts`

- [ ] **Step 1: Add a regression test that a failed chunk retries without rerunning successful sibling chunks**

```ts
it("retries only the failing chunk after chunk parallelism is enabled", async () => {
  await runTranslations(repoDir, silentLogger);

  expect(
    mockTranslateTaskWithOpenAi.mock.calls.map((call) => call[0].task.taskId),
  ).toEqual([
    "task_dc3d488a4e__chunk_1",
    "task_dc3d488a4e__chunk_2",
    "task_dc3d488a4e__chunk_2",
  ]);
});
```

- [ ] **Step 2: Run the targeted retry regression test**

Run: `pnpm test -- packages/core/src/__tests__/core.test.ts -t "retries only the failing chunk after chunk parallelism is enabled"`

Expected: PASS. If it fails, stop and fix retry-state leakage before editing docs.

- [ ] **Step 3: Update user-facing docs to describe the new concurrency rule**

Add one aligned paragraph to each doc:

```md
`ai.concurrency` is still the only translation concurrency setting. Page scheduling keeps priority, and when fewer pages are active than the concurrency budget, DocuMirror may use the remaining request slots to translate additional runtime chunks from those pages in parallel. Persisted task and result files still remain page-based.
```

- [ ] **Step 4: Run the full required validation suite**

Run: `pnpm lint`

Expected: PASS

Run: `pnpm typecheck`

Expected: PASS

Run: `pnpm test`

Expected: PASS

Run: `pnpm build`

Expected: PASS

- [ ] **Step 5: Commit the docs and final verified implementation**

```bash
git add packages/core/src/__tests__/core.test.ts README.md README.zh.md packages/cli/README.md packages/templates/src/task-guide.ts
git commit -m "docs(repo): document translate run chunk scheduling"
```

## Execution Notes

- Do not add a new config field such as `chunkConcurrency`.
- Do not introduce persisted chunk task/result files.
- Keep `translate apply` untouched unless tests prove a real regression.
- If a scheduling bug appears during implementation, add or extend coordinator unit tests before changing production code again.
- If progress rendering becomes noisy, prefer clearer formatting over suppressing parallel chunk visibility.
