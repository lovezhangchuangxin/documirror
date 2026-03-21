import { availableParallelism } from "node:os";

export function resolveFileIoConcurrency(): number {
  return Math.min(Math.max(2, Math.floor(getAvailableParallelism() / 2)), 8);
}

export function getAvailableParallelism(): number {
  try {
    return availableParallelism();
  } catch {
    return 4;
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason));
  }
}

export function isAbortLikeError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) {
    return true;
  }

  if (error instanceof Error) {
    return (
      error.name === "AbortError" ||
      error.name === "APIUserAbortError" ||
      error.message === "Request was aborted."
    );
  }

  return false;
}
