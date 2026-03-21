import type { CommandProfile } from "../types";

type ProfiledError = Error & {
  profile?: CommandProfile;
};

export type CommandProfileRecorder = {
  measure: <T>(label: string, run: () => Promise<T>) => Promise<T>;
  record: (label: string, durationMs: number) => void;
  finish: () => CommandProfile | undefined;
};

export function createCommandProfileRecorder(
  enabled: boolean | undefined,
): CommandProfileRecorder {
  const startedAt = Date.now();
  const steps: CommandProfile["steps"] = [];

  return {
    async measure<T>(label: string, run: () => Promise<T>): Promise<T> {
      const stepStartedAt = Date.now();
      try {
        return await run();
      } finally {
        if (enabled) {
          steps.push({
            label,
            durationMs: Date.now() - stepStartedAt,
          });
        }
      }
    },
    record(label: string, durationMs: number): void {
      if (!enabled) {
        return;
      }

      steps.push({
        label,
        durationMs,
      });
    },
    finish(): CommandProfile | undefined {
      if (!enabled) {
        return undefined;
      }

      return {
        totalDurationMs: Date.now() - startedAt,
        steps,
      };
    },
  };
}

export function attachCommandProfile(
  error: unknown,
  profile: CommandProfile | undefined,
): Error {
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));

  if (profile) {
    (normalizedError as ProfiledError).profile = profile;
  }

  return normalizedError;
}

export function extractCommandProfile(
  error: unknown,
): CommandProfile | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  return (error as ProfiledError).profile;
}
