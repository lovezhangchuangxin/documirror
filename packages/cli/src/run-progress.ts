import type { RunTranslationsProgressEvent } from "@documirror/core";
import pc from "picocolors";

type ActiveRunTask = {
  taskId: string;
  attempt: number;
  maxAttempts: number;
  chunk?: {
    chunkIndex: number;
    chunkCount: number;
    itemStart: number;
    itemEnd: number;
    headingText?: string;
  };
  /** When the current attempt started (for timeout detection) */
  attemptStartedAt: number;
  /** When the task first started (for total duration tracking) */
  taskStartedAt: number;
};

export type RunProgressState = {
  total: number;
  completed: number;
  successCount: number;
  failureCount: number;
  concurrency: number;
  provider: string;
  model: string;
  requestTimeoutMs: number;
  startedAt: number;
  activeTasks: Map<string, ActiveRunTask>;
  // Metrics for success rate and average duration
  totalAttempts: number;
  successfulAttempts: number;
  totalSuccessDurationMs: number;
  successWithDurationCount: number;
};

export function createRunProgressState(now = Date.now()): RunProgressState {
  return {
    total: 0,
    completed: 0,
    successCount: 0,
    failureCount: 0,
    concurrency: 0,
    provider: "",
    model: "",
    requestTimeoutMs: 0,
    startedAt: now,
    activeTasks: new Map(),
    totalAttempts: 0,
    successfulAttempts: 0,
    totalSuccessDurationMs: 0,
    successWithDurationCount: 0,
  };
}

export function applyRunProgressEvent(
  state: RunProgressState,
  event: RunTranslationsProgressEvent,
  now = Date.now(),
): void {
  if (event.type === "queued") {
    state.total = event.total;
    state.completed = 0;
    state.successCount = 0;
    state.failureCount = 0;
    state.concurrency = event.concurrency;
    state.provider = event.provider;
    state.model = event.model;
    state.requestTimeoutMs = event.requestTimeoutMs;
    state.startedAt = now;
    state.activeTasks.clear();
    state.totalAttempts = 0;
    state.successfulAttempts = 0;
    state.totalSuccessDurationMs = 0;
    state.successWithDurationCount = 0;
    return;
  }

  state.total = event.total;
  state.completed = event.completed;

  if (event.type === "started") {
    // Task starts - initialize with fresh timestamps
    state.activeTasks.set(event.taskId, {
      taskId: event.taskId,
      attempt: 1,
      maxAttempts: 0,
      chunk: undefined,
      attemptStartedAt: now,
      taskStartedAt: now,
    });
    return;
  }

  if (event.type === "attempt") {
    state.totalAttempts += 1;
    const current = state.activeTasks.get(event.taskId);
    state.activeTasks.set(event.taskId, {
      taskId: event.taskId,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      chunk: event.chunk,
      attemptStartedAt: now,
      // Preserve the original task start time
      taskStartedAt: current?.taskStartedAt ?? now,
    });
    return;
  }

  if (event.type === "attemptCompleted") {
    state.successfulAttempts += 1;
    const current = state.activeTasks.get(event.taskId);
    if (current) {
      state.activeTasks.set(event.taskId, {
        ...current,
        chunk: event.chunk ?? current.chunk,
      });
    }
    return;
  }

  // For completed/failed events
  const activeTask = state.activeTasks.get(event.taskId);
  if (activeTask) {
    // Use taskStartedAt to track total duration from task start (including retries)
    const durationMs = now - activeTask.taskStartedAt;
    if (event.type === "completed") {
      state.totalSuccessDurationMs += durationMs;
      state.successWithDurationCount += 1;
    }
    // Note: failed attempts are already counted via totalAttempts - successCount
  }

  state.successCount = event.successCount;
  state.failureCount = event.failureCount;
  state.activeTasks.delete(event.taskId);
}

export function formatRunProgressMessage(
  state: RunProgressState,
  now = Date.now(),
): string {
  if (state.total === 0) {
    return "Running automatic translation: no pending tasks";
  }

  // Colored summary parts with progress gradient
  const progressPct = (state.completed / state.total) * 100;
  const progressColored =
    progressPct >= 100
      ? pc.green(`${state.completed}/${state.total}`)
      : progressPct >= 50
        ? pc.cyan(`${state.completed}/${state.total}`)
        : pc.gray(`${state.completed}/${state.total}`);

  const summary = [
    `${progressColored} complete`,
    pc.green(`${state.successCount} succeeded`),
    state.failureCount > 0
      ? pc.red(`${state.failureCount} failed`)
      : `${state.failureCount} failed`,
    pc.cyan(`${state.activeTasks.size} running`),
    pc.gray(
      `${Math.max(0, state.total - state.completed - state.activeTasks.size)} waiting`,
    ),
  ];

  // Calculate metrics
  // Average duration: total time from task start to completion (including retries)
  const avgDuration =
    state.successWithDurationCount > 0
      ? state.totalSuccessDurationMs / state.successWithDurationCount
      : 0;
  // Success rate: successful translation attempts / total attempts.
  // With chunked page tasks, each validated chunk counts as one successful attempt.
  const successRate =
    state.totalAttempts > 0
      ? (state.successfulAttempts / state.totalAttempts) * 100
      : 100;

  const metrics: string[] = [];
  if (avgDuration > 0) {
    metrics.push(`avg ${formatDuration(avgDuration)}/task`);
  }
  if (state.totalAttempts > 0) {
    // Color success rate based on value
    const rateStr = `${successRate.toFixed(0)}% success`;
    if (successRate >= 80) {
      metrics.push(pc.green(rateStr));
    } else if (successRate >= 50) {
      metrics.push(pc.yellow(rateStr));
    } else {
      metrics.push(pc.red(rateStr));
    }
  }

  const details = [
    formatModelLabel(state.provider, state.model),
    `concurrency ${state.concurrency}`,
    `timeout ${formatSeconds(state.requestTimeoutMs)}`,
    `elapsed ${formatDuration(now - state.startedAt)}`,
    ...metrics,
  ].filter((part) => part.length > 0);

  // Header line with summary and config info
  const header = [
    `Running automatic translation: ${summary.join(", ")}`,
    details.join(", "),
  ].join(" | ");

  // If no active tasks, show simple status
  if (state.activeTasks.size === 0) {
    if (state.completed < state.total) {
      return `${header}\n  ${pc.gray("└─")} waiting to schedule next task`;
    }
    return header;
  }

  // Format each active task on its own line
  const activeTaskLines = formatActiveTaskLines(state, now);

  return [header, ...activeTaskLines].join("\n");
}

function formatModelLabel(provider: string, model: string): string {
  if (!provider && !model) {
    return "";
  }

  return `model ${provider}/${model}`.replace(/\/$/u, "");
}

function formatActiveTaskLines(state: RunProgressState, now: number): string[] {
  const activeTasks = [...state.activeTasks.values()].sort(
    (left, right) => left.attemptStartedAt - right.attemptStartedAt,
  );

  return activeTasks.map((task, index) => {
    const isLast = index === activeTasks.length - 1;
    const prefix = isLast ? pc.gray("  └─") : pc.gray("  ├─");

    const attempt =
      task.maxAttempts > 0
        ? `${task.attempt}/${task.maxAttempts}`
        : `${task.attempt}`;
    const waitMs = now - task.attemptStartedAt;
    const isPastTimeout =
      state.requestTimeoutMs > 0 && waitMs > state.requestTimeoutMs;
    const timeoutHint = isPastTimeout ? pc.red(" ⚠ past timeout") : "";

    // Color the task ID in cyan
    const taskIdStr = pc.cyan(task.taskId);
    // Color attempt info based on retry count
    const attemptStr =
      task.attempt > 1
        ? pc.yellow(`attempt ${attempt}`)
        : pc.dim(`attempt ${attempt}`);
    const chunkStr = task.chunk
      ? pc.dim(formatChunkLabel(task.chunk))
      : undefined;
    // Color waiting time based on timeout status
    const waitingStr = isPastTimeout
      ? pc.red(`waiting ${formatDuration(waitMs)}`)
      : pc.dim(`waiting ${formatDuration(waitMs)}`);

    return `${prefix} [${taskIdStr}] ${[attemptStr, chunkStr, waitingStr]
      .filter(Boolean)
      .join(", ")}${timeoutHint}`;
  });
}

function formatChunkLabel(chunk: NonNullable<ActiveRunTask["chunk"]>): string {
  const base = `chunk ${chunk.chunkIndex}/${chunk.chunkCount}, items ${chunk.itemStart}-${chunk.itemEnd}`;
  if (!chunk.headingText) {
    return base;
  }

  return `${base}, heading "${truncateHeading(chunk.headingText, 32)}"`;
}

function truncateHeading(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatSeconds(milliseconds: number): string {
  return `${Math.max(1, Math.round(milliseconds / 1000))}s`;
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
