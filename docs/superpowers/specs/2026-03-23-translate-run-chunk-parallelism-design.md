# Translate Run Chunk Parallelism Design

## Summary

`translate run` already supports page-level concurrency through `ai.concurrency`, but large page tasks still execute their runtime chunks sequentially. This makes a single large page artificially slow even when global concurrency still has spare capacity.

This design keeps page tasks as the persisted unit while allowing runtime chunks from the same page to borrow unused request slots from the existing global `ai.concurrency` budget.

The target behavior is:

- `ai.concurrency` remains the only concurrency knob
- page-level scheduling keeps priority over page-internal chunk fan-out
- if pending pages are enough to fill the concurrency budget, each active page runs at most one chunk at a time
- if active page count is lower than the concurrency budget, spare request slots may be used to run additional chunks from already-active pages in parallel
- persisted task files, result files, and `translate apply` stay page-based

## Goals

- Reduce end-to-end `translate run` latency for large page tasks
- Preserve the current page-based storage contract under `.documirror/tasks/`
- Preserve chunk-local retry behavior so only failing chunks are retried
- Preserve the current provider boundary: scheduling stays in `packages/core`, request execution stays in `packages/adapters-openai`
- Keep CLI behavior predictable by continuing to treat `ai.concurrency` as the single global request budget

## Non-Goals

- No new persisted chunk task files or chunk result files
- No second concurrency setting such as `chunkConcurrency`
- No provider-specific batch API integration
- No change to `translate apply` input shape
- No attempt to reorder or reprioritize pages based on size or estimated latency

## Current Behavior

The current flow splits page tasks into runtime chunks in `packages/core/src/page-chunking.ts`, but `packages/core/src/translate/services/task-runner.ts` executes them with a sequential `for ... of` loop. Meanwhile `packages/core/src/translate/commands/run.ts` uses `p-limit(config.ai.concurrency)` to run page tasks in parallel.

This creates two mismatched schedulers:

- outer scheduler: parallel by page
- inner scheduler: sequential by chunk

The result is that `ai.concurrency` limits only page count, not in-flight AI requests. If there are fewer active pages than the concurrency budget, the remaining capacity is left idle.

## Constraints And Invariants

- `translate run` may split a large page task internally, but persisted tasks and results remain page-based
- merged page results must still pass the same verification path before being written to `tasks/done`
- `translate apply` must continue to consume exactly one done result per page task
- task/result schemas must remain compatible for existing repositories
- chunk completion order is not stable once parallelized; merge logic must become order-independent
- failure reporting and progress tracking can no longer assume one active request per `taskId`

## Proposed Architecture

### 1. Replace Nested Scheduling With A Single Coordinator

Move request scheduling ownership into a new run coordinator inside `packages/core/src/translate/commands/run.ts` or a dedicated service under `packages/core/src/translate/services/`.

The coordinator manages:

- queued page tasks
- active page contexts
- in-flight request count
- completion and failure counters

Each active page context holds:

- the loaded page task and mapping
- its planned chunks
- per-chunk execution state
- completed chunk drafts indexed by `chunkIndex`
- page failure state

`runTaskView()` remains the execution primitive for one chunk view, including request, validation, and retry behavior.

### 2. Keep Page Tasks As The Public Unit

The scheduler still starts from pending page tasks in the manifest. Runtime chunks are internal scheduling units only.

Persisted outputs stay unchanged:

- success: write one merged page-level result to `tasks/done/<taskId>.json`
- failure: write one page-level run report to `reports/translation-run/<taskId>.json`

This preserves `translate apply`, manifest sync, and user expectations.

### 3. Use Two-Phase Slot Allocation

For a global budget `N = ai.concurrency`:

1. Fill page slots first.
2. Only if active page count is below `N`, allow extra chunks from already-active pages to consume the remaining request slots.

This gives page-level scheduling priority without wasting spare capacity.

Effective behavior:

- if there are `N` or more runnable pages, at most one chunk per active page is in flight
- if there are fewer than `N` runnable pages, the remaining slots may be used for additional chunks from those active pages

## Scheduling Model

### Page Context State

Each active page context should track:

- `taskId`
- `task`, `mapping`, `chunkPlan`
- `pendingChunkIndices`
- `runningChunkIndices`
- `completedChunkDraftsByIndex`
- `failedChunkReports`
- `done`
- `fatalError`

Recommended shape:

```ts
type ActivePageRun = {
  taskId: string;
  chunkPlan: PageChunkPlan;
  pendingChunkIndices: number[];
  runningChunkIndices: Set<number>;
  completedChunkDraftsByIndex: Map<number, ChunkDraftResult>;
  failedChunkReports: ChunkFailureState[];
  done: boolean;
  fatalError?: Error;
};
```

### Dispatch Rules

The coordinator loop should repeatedly:

1. Start new pages while `activePages.size < concurrency`.
2. Ensure every newly activated page gets one initial chunk.
3. If `inFlightRequests < concurrency` and `activePages.size < concurrency`, fan out extra chunks from active pages that still have pending work.
4. Wait for any in-flight chunk to finish.
5. Update page state, then repeat until all pages finish or the run is aborted.

### Fairness Rule

When multiple active pages can consume spare slots, choose the next page in stable activation order and skip pages with no pending chunks. Round-robin is sufficient. The design does not require size-aware scheduling.

This avoids one large page monopolizing all spare slots.

## Chunk Execution

### Preserve Existing Retry Semantics

Chunk retry behavior should stay local to `runTaskView()`:

- each chunk retries up to `config.ai.maxAttemptsPerTask`
- only the failing chunk is retried
- successful sibling chunks are retained in memory and are not rerun

This keeps the already-correct behavior tested in `packages/core/src/__tests__/core.test.ts`.

### Remove Shared Page-Level Report Writes From Chunk Workers

Today `runTaskView()` writes `reports/translation-run/<taskId>.json` directly on failure. With chunk parallelism that causes a race because sibling chunks share the same page `taskId`.

Change the responsibility split:

- chunk executor returns structured failure details to the page coordinator
- page coordinator writes the final page-level run report once, after page completion or fatal failure

Chunk workers may still produce in-memory failure payloads per attempt, but they should not compete to write the page report file.

## Merge Semantics

`packages/core/src/page-chunking.ts` currently merges chunk drafts in array order. That only works because chunk execution is sequential.

After parallelization:

- completed chunk drafts must be stored by `chunkIndex`
- merge must sort by `chunk.chunkIndex` before flattening translations

This preserves source ordering regardless of completion order.

No change is needed to the final page result schema.

## Progress Event Design

The current CLI progress model stores active work in a `Map<taskId, ActiveRunTask>`. That cannot represent two concurrent chunks from the same page.

Update `RunTranslationsProgressEvent` in `packages/core/src/types.ts` so active work has a unique request identity:

- `activityId`: unique in-flight execution id, using `chunk.chunkId` for chunked work and `taskId` for whole-task work
- `pageTaskId`: original page task id

Recommended event changes:

- keep `taskId` as the page task id for summary accounting
- add `activityId` for active-request tracking
- keep existing optional `chunk` metadata for display

Then update `packages/cli/src/run-progress.ts` to key `activeTasks` by `activityId` instead of page `taskId`.

Expected CLI effect:

- multiple lines may appear for one page if multiple chunks are in flight
- summary counts remain page-based for completed and failed tasks

## Failure Report Design

Keep the report file path page-based:

- `reports/translation-run/<taskId>.json`

Extend the report payload with optional chunk details instead of creating chunk-named report files. Recommended shape:

```json
{
  "schemaVersion": 2,
  "taskId": "task_xxx",
  "failedAt": "...",
  "attemptCount": 3,
  "message": "Page translation failed",
  "errors": [],
  "chunks": [
    {
      "chunkId": "task_xxx__chunk_2",
      "chunkIndex": 2,
      "chunkCount": 4,
      "itemStart": 81,
      "itemEnd": 140,
      "headingText": "Deploy",
      "attemptCount": 3,
      "message": "Validation failed",
      "errors": [],
      "resultPreview": "..."
    }
  ]
}
```

Compatibility guidance:

- manifest sync in `packages/core/src/translate/services/task-manifest.ts` should continue reading the top-level `failedAt` and `message`
- chunk detail is supplemental for debugging only
- legacy schema version `1` reports should still load

## Cancellation And Abort Semantics

Abort behavior should remain fail-fast at the run level:

- if the shared signal is aborted, no new pages or chunks are scheduled
- in-flight OpenAI requests receive the same signal
- the coordinator waits for aborted promises to settle before returning or throwing

No partial page result should be written on abort.

## Configuration Impact

No new config fields are required.

`ai.concurrency` keeps a single meaning:

- maximum active request budget across the whole run

The documentation should explicitly clarify the new borrowing rule:

- page scheduling is prioritized
- spare capacity may be used by additional chunks from already-active pages

No schema changes are needed in `packages/shared/src/schemas/config.ts`.

## File-Level Change Plan

Primary code areas:

- `packages/core/src/translate/commands/run.ts`
  - replace outer `p-limit`-based page execution with the coordinator
- `packages/core/src/translate/services/task-runner.ts`
  - split page orchestration from single-chunk execution
  - stop direct page-level failure report writes from chunk workers
- `packages/core/src/page-chunking.ts`
  - make merge order-independent by sorting chunks by `chunkIndex`
- `packages/core/src/types.ts`
  - extend progress event types for concurrent chunk activities
- `packages/cli/src/run-progress.ts`
  - track active work by `activityId`
- `packages/core/src/translate/infra/reports.ts`
  - support page-level reports with chunk detail aggregation
- `packages/core/src/translate/services/task-manifest.ts`
  - keep compatibility with updated run report schema

Documentation updates:

- `README.md`
- `README.zh.md`
- `packages/cli/README.md`
- `packages/templates/src/task-guide.ts`

## Testing Strategy

### New Behavioral Tests

- page-count-greater-than-budget:
  - with `concurrency = 4` and `>= 4` pending pages, verify only one chunk per page is in flight
- page-count-less-than-budget:
  - with `concurrency = 4` and `2` pending pages, verify extra chunks are allowed and max in-flight requests reaches `4`
- mixed fairness:
  - verify spare slots are shared across active pages instead of being consumed by one page only

### Existing Behavior To Preserve

- chunk retry reruns only the failing chunk
- merged page result remains page-based and ordered correctly
- `translate apply` still accepts merged page results without changes
- manifest and queue outputs remain page-based

### Report And Progress Tests

- concurrent chunk failures do not overwrite each other
- CLI progress can show multiple in-flight chunk activities for one page
- summary counters remain page-based even when attempt counters are chunk-based

## Risks

### Risk: Progress Complexity Increases

The CLI progress model becomes more detailed because one page may now have multiple active rows. This is acceptable, but the key invariant is that completion and failure counts must remain page-based to avoid misleading totals.

### Risk: Report Schema Drift

If report aggregation is changed without manifest compatibility, `lastRunStatus` and `lastRunError` may regress. The manifest loader should stay tolerant and only depend on the top-level fields.

### Risk: Hidden Ordering Bugs

Parallel chunk completion can expose implicit array-order assumptions. Merge logic must sort by `chunkIndex`, and tests should deliberately resolve chunks out of order.

## Rollout Notes

This is a safe incremental change because it does not alter persisted task shape, result shape, apply behavior, or provider integration boundaries. The highest-risk areas are internal scheduling, progress display, and failure-report aggregation.

The implementation should land behind the existing config surface, with no migration required for current repositories.
