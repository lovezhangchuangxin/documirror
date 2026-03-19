import { setTimeout as delay } from "node:timers/promises";

import axios, { type AxiosResponse } from "axios";

type RequestResponseType = "arraybuffer" | "text";

type RequestOptions = {
  url: string;
  headers: Record<string, string>;
  responseType: RequestResponseType;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  isRetryableStatus?: (status: number) => boolean;
};

type RequestSuccess<T> = {
  ok: true;
  response: AxiosResponse<T>;
  attemptCount: number;
  timeoutCount: number;
};

type RequestFailure = {
  ok: false;
  errorMessage: string;
  code?: string;
  attemptCount: number;
  timeoutCount: number;
};

export type RequestResult<T> = RequestSuccess<T> | RequestFailure;

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ERR_NETWORK",
]);

export async function requestWithRetry<T>(
  options: RequestOptions,
): Promise<RequestResult<T>> {
  const isRetryableStatus =
    options.isRetryableStatus ?? defaultRetryableStatusMatcher;
  let timeoutCount = 0;

  for (let attempt = 0; attempt <= options.retryCount; attempt += 1) {
    try {
      const response = await axios.get<T>(options.url, {
        headers: options.headers,
        responseType: options.responseType,
        timeout: options.timeoutMs,
        validateStatus: () => true,
      });

      if (
        attempt < options.retryCount &&
        isRetryableStatus(response.status ?? 0)
      ) {
        await delay(
          resolveRetryDelayMs(
            attempt,
            response.headers["retry-after"],
            options.retryDelayMs,
          ),
        );
        continue;
      }

      return {
        ok: true,
        response,
        attemptCount: attempt + 1,
        timeoutCount,
      };
    } catch (error) {
      const normalized = normalizeRequestError(error, options.timeoutMs);
      if (normalized.timedOut) {
        timeoutCount += 1;
      }

      if (attempt < options.retryCount && normalized.retryable) {
        await delay(
          resolveRetryDelayMs(attempt, undefined, options.retryDelayMs),
        );
        continue;
      }

      return {
        ok: false,
        errorMessage: normalized.message,
        code: normalized.code,
        attemptCount: attempt + 1,
        timeoutCount,
      };
    }
  }

  return {
    ok: false,
    errorMessage: "Request failed unexpectedly",
    attemptCount: options.retryCount + 1,
    timeoutCount,
  };
}

function defaultRetryableStatusMatcher(status: number): boolean {
  return RETRYABLE_STATUS_CODES.has(status);
}

function resolveRetryDelayMs(
  attempt: number,
  retryAfterHeader: string | string[] | undefined,
  baseDelayMs: number,
): number {
  const retryAfterDelay = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterDelay !== null) {
    return retryAfterDelay;
  }

  return baseDelayMs * 2 ** attempt;
}

function parseRetryAfterMs(
  value: string | string[] | undefined,
): number | null {
  const rawValue = Array.isArray(value) ? value[0] : value;
  if (!rawValue) {
    return null;
  }

  const seconds = Number(rawValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }

  const retryAt = Date.parse(rawValue);
  if (Number.isNaN(retryAt)) {
    return null;
  }

  return Math.max(0, retryAt - Date.now());
}

function normalizeRequestError(
  error: unknown,
  timeoutMs: number,
): {
  message: string;
  code?: string;
  retryable: boolean;
  timedOut: boolean;
} {
  if (axios.isAxiosError(error)) {
    const code = error.code;
    const timedOut =
      code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      error.message.toLowerCase().includes("timeout");
    const retryable =
      timedOut ||
      !error.response ||
      (code !== undefined && RETRYABLE_ERROR_CODES.has(code));

    if (timedOut) {
      return {
        message: `Request timed out after ${timeoutMs}ms`,
        code,
        retryable,
        timedOut,
      };
    }

    const message = error.message.trim() || "Network request failed";
    return {
      message: code ? `${code}: ${message}` : message,
      code,
      retryable,
      timedOut,
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    timedOut: false,
  };
}
