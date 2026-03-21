import type { TranslationVerificationIssue } from "@documirror/shared";

import type { PlannedPageChunk } from "../page-chunking";

export function createRunDebugEmitter(
  onDebug?: (message: string) => void,
): (message: string) => void {
  if (!onDebug) {
    return () => {};
  }

  return (message: string) => {
    onDebug(message);
  };
}

export function formatIssueSummary(
  issue: TranslationVerificationIssue | undefined,
): string {
  if (!issue) {
    return "unknown error";
  }

  return `[${issue.code}] ${issue.message}`;
}

export function describeTaskView(
  taskId: string,
  chunk: PlannedPageChunk | undefined,
): string {
  if (!chunk) {
    return taskId;
  }

  const range = formatChunkRange(
    chunk.headingText,
    chunk.itemStart,
    chunk.itemEnd,
  );
  return `${taskId} [chunk ${chunk.chunkIndex + 1}/${chunk.chunkCount}: ${range}]`;
}

export function formatChunkRange(
  headingText: string | undefined,
  itemStart: number,
  itemEnd: number,
): string {
  const range = `items ${itemStart}-${itemEnd}`;
  if (!headingText) {
    return range;
  }

  return `${range}, heading "${truncateForLog(headingText, 60)}"`;
}

export function truncateForLog(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function formatRunDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${totalSeconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
