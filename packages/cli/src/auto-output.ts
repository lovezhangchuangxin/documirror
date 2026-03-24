import type {
  AutoPipelineStage,
  AutoPipelineStageSummary,
  AutoPipelineSummary,
} from "@documirror/core";
import type { CommandProfile } from "@documirror/shared";

import {
  formatRunProgressMessage,
  type RunProgressState,
} from "./run-progress";

const AUTO_STAGE_COUNT = 4;

export function formatAutoStageTitle(stage: AutoPipelineStage): string {
  return `Auto ${getStageIndex(stage)}/${AUTO_STAGE_COUNT}: ${getStageLabel(stage)}`;
}

export function formatAutoUpdateProgress(
  pageCount: number,
  assetCount: number,
): string {
  return `${formatAutoStageTitle("update")} | crawled ${formatCount(pageCount, "page")}, ${formatCount(assetCount, "asset")}`;
}

export function formatAutoRunProgress(
  progressState: RunProgressState,
  now = Date.now(),
): string {
  return [
    formatAutoStageTitle("run"),
    formatRunProgressMessage(progressState, now),
  ].join("\n");
}

export function formatAutoStageSummary(
  summary: AutoPipelineStageSummary,
): string[] {
  switch (summary.stage) {
    case "update":
      if (summary.status === "failed") {
        return [`update: failed | ${summary.error}`];
      }
      if (summary.status === "skipped") {
        return ["update: skipped"];
      }
      return [
        `update: ok | crawled ${formatCount(summary.crawl?.pageCount ?? 0, "page")}, ${formatCount(summary.crawl?.assetCount ?? 0, "asset")} | extracted ${formatCount(summary.extract?.segmentCount ?? 0, "segment")} from ${formatCount(summary.extract?.pageCount ?? 0, "page")} | planned ${formatCount(summary.plan?.taskCount ?? 0, "task")} for ${formatCount(summary.plan?.segmentCount ?? 0, "segment")}`,
      ];
    case "run":
      if (summary.status === "failed") {
        return [`translate run: failed | ${summary.error}`];
      }
      if (summary.status === "skipped") {
        return ["translate run: skipped"];
      }
      return [
        `translate run: ${summary.status} | completed ${summary.summary?.completedTasks ?? 0}/${summary.summary?.totalTasks ?? 0}, ${summary.summary?.successCount ?? 0} succeeded, ${summary.summary?.failureCount ?? 0} failed | reports: ${summary.summary?.reportDir ?? "-"}`,
      ];
    case "apply":
      return [
        ...formatStandardStageSummary(
          "translate apply",
          summary.status,
          summary.status === "ok" && summary.summary
            ? `${formatCount(summary.summary.appliedFiles, "result file")}, ${formatCount(summary.summary.appliedSegments, "segment")} applied`
            : undefined,
          summary.error,
        ),
        ...formatProfileLines(summary.profile ?? summary.summary?.profile),
      ];
    case "build":
      return [
        ...formatStandardStageSummary(
          "build",
          summary.status,
          summary.status === "ok" && summary.summary
            ? `built ${formatCount(summary.summary.pageCount, "page")}, ${formatCount(summary.summary.assetCount, "asset")}, missing ${formatCount(summary.summary.missingTranslations, "translation")}`
            : undefined,
          summary.error,
        ),
        ...formatProfileLines(summary.profile ?? summary.summary?.profile),
      ];
  }
}

export function formatAutoFinalSummary(summary: AutoPipelineSummary): string[] {
  return [
    "Auto Summary",
    ...formatAutoStageSummary(summary.update),
    ...formatAutoStageSummary(summary.run),
    ...formatAutoStageSummary(summary.apply).filter(
      (line) => !line.startsWith("profile: "),
    ),
    ...formatAutoStageSummary(summary.build).filter(
      (line) => !line.startsWith("profile: "),
    ),
  ];
}

export function formatAutoCompletionMessage(
  summary: AutoPipelineSummary,
): string {
  if (summary.ok) {
    return "Auto pipeline finished successfully";
  }

  if (summary.blockingError) {
    return `Auto pipeline failed during ${getStageLabel(summary.blockingError.stage)}`;
  }

  if (summary.run.status === "partial") {
    return "Auto pipeline finished with translation failures; built site from partial results";
  }

  return "Auto pipeline failed";
}

function formatStandardStageSummary(
  label: string,
  status: "ok" | "failed" | "skipped",
  details?: string,
  error?: string,
): string[] {
  switch (status) {
    case "ok":
      return [`${label}: ok | ${details ?? ""}`.replace(/ \| $/u, "")];
    case "failed":
      return [`${label}: failed | ${error}`];
    case "skipped":
      return [`${label}: skipped`];
  }
}

function formatProfileLines(profile: CommandProfile | undefined): string[] {
  if (!profile) {
    return [];
  }

  return [
    ...profile.steps.map(
      (step) => `profile: ${step.label} ${formatMilliseconds(step.durationMs)}`,
    ),
    `profile: total ${formatMilliseconds(profile.totalDurationMs)}`,
  ];
}

function formatMilliseconds(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function getStageIndex(stage: AutoPipelineStage): number {
  switch (stage) {
    case "update":
      return 1;
    case "run":
      return 2;
    case "apply":
      return 3;
    case "build":
      return 4;
  }
}

function getStageLabel(stage: AutoPipelineStage): string {
  switch (stage) {
    case "update":
      return "update";
    case "run":
      return "translate run";
    case "apply":
      return "translate apply";
    case "build":
      return "build";
  }
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
