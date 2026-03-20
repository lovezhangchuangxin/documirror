import type { RunTranslationsProgressEvent } from "@documirror/core";

type ActiveRunTask = {
  taskId: string;
  attempt: number;
  maxAttempts: number;
  attemptStartedAt: number;
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
    return;
  }

  state.total = event.total;
  state.completed = event.completed;

  if (event.type === "started") {
    const current = state.activeTasks.get(event.taskId);
    state.activeTasks.set(event.taskId, {
      taskId: event.taskId,
      attempt: current?.attempt ?? 1,
      maxAttempts: current?.maxAttempts ?? 0,
      attemptStartedAt: current?.attemptStartedAt ?? now,
    });
    return;
  }

  if (event.type === "attempt") {
    state.activeTasks.set(event.taskId, {
      taskId: event.taskId,
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      attemptStartedAt: now,
    });
    return;
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

  const summary = [
    `${state.completed}/${state.total} complete`,
    `${state.successCount} succeeded`,
    `${state.failureCount} failed`,
    `${state.activeTasks.size} running`,
    `${Math.max(0, state.total - state.completed - state.activeTasks.size)} waiting`,
  ];
  const details = [
    formatModelLabel(state.provider, state.model),
    `concurrency ${state.concurrency}`,
    `timeout ${formatSeconds(state.requestTimeoutMs)}`,
    `elapsed ${formatDuration(now - state.startedAt)}`,
  ].filter((part) => part.length > 0);
  const activeSummary = formatActiveTaskSummary(state, now);

  return [
    `Running automatic translation: ${summary.join(", ")}`,
    details.join(", "),
    activeSummary,
  ]
    .filter((part) => part.length > 0)
    .join(" | ");
}

function formatModelLabel(provider: string, model: string): string {
  if (!provider && !model) {
    return "";
  }

  return `model ${provider}/${model}`.replace(/\/$/u, "");
}

function formatActiveTaskSummary(state: RunProgressState, now: number): string {
  if (state.activeTasks.size === 0) {
    if (state.completed < state.total) {
      return "waiting to schedule the next task";
    }

    return "";
  }

  const activeTasks = [...state.activeTasks.values()].sort(
    (left, right) => left.attemptStartedAt - right.attemptStartedAt,
  );
  const preview = activeTasks.slice(0, 2).map((task) => {
    const attempt =
      task.maxAttempts > 0
        ? `${task.attempt}/${task.maxAttempts}`
        : `${task.attempt}`;
    const waitMs = now - task.attemptStartedAt;
    const timeoutHint =
      state.requestTimeoutMs > 0 && waitMs > state.requestTimeoutMs
        ? " (past timeout)"
        : "";
    return `${task.taskId} attempt ${attempt} for ${formatDuration(waitMs)}${timeoutHint}`;
  });
  const remaining =
    activeTasks.length > preview.length
      ? `, +${activeTasks.length - preview.length} more`
      : "";

  return `waiting for model responses: ${preview.join(", ")}${remaining}`;
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
