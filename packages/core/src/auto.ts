import type { Logger } from "@documirror/shared";
import { defaultLogger, extractCommandProfile } from "@documirror/shared";

import { buildMirror } from "./build";
import { crawlMirror } from "./crawl";
import { extractMirror } from "./extract";
import {
  applyTranslations,
  planTranslations,
  runTranslations,
} from "./translate";
import type {
  AutoApplyStageSummary,
  AutoBuildStageSummary,
  AutoPipelineProgressEvent,
  AutoPipelineStage,
  AutoPipelineSummary,
  AutoRunStageSummary,
  AutoUpdateStageSummary,
  RunAutoPipelineOptions,
} from "./types";

const AUTO_STAGES: AutoPipelineStage[] = ["update", "run", "apply", "build"];

export async function runAutoPipeline(
  repoDir: string,
  logger: Logger = defaultLogger,
  onProgress?: (event: AutoPipelineProgressEvent) => void,
  signal?: AbortSignal,
  options: RunAutoPipelineOptions = {},
): Promise<AutoPipelineSummary> {
  const summary: AutoPipelineSummary = {
    ok: false,
    update: createSkippedUpdateSummary(),
    run: createSkippedRunSummary(),
    apply: createSkippedApplySummary(),
    build: createSkippedBuildSummary(),
  };

  onProgress?.(createStageStartedEvent("update"));
  let crawlSummary: AutoUpdateStageSummary["crawl"];
  try {
    crawlSummary = await crawlMirror(
      repoDir,
      logger,
      (progress) => {
        onProgress?.({
          type: "crawlProgress",
          stage: "update",
          progress,
        });
      },
      signal,
    );
    if (shouldFailAutoCrawl(crawlSummary)) {
      throw new Error(formatAutoFatalCrawlMessage(crawlSummary));
    }

    const extractSummary = await extractMirror(repoDir, logger);
    const planSummary = await planTranslations(repoDir, logger);
    summary.update = {
      stage: "update",
      status: "ok",
      crawl: crawlSummary,
      extract: extractSummary,
      plan: planSummary,
    };
    onProgress?.({
      type: "stageCompleted",
      stage: "update",
      stepIndex: getStageIndex("update"),
      stepCount: AUTO_STAGES.length,
      summary: summary.update,
    });
  } catch (error) {
    rethrowIfAborted(error, signal);
    const message = toErrorMessage(error);
    summary.update = {
      stage: "update",
      status: "failed",
      crawl: crawlSummary,
      error: message,
    };
    summary.blockingError = {
      stage: "update",
      message,
    };
    onProgress?.({
      type: "stageFailed",
      stage: "update",
      stepIndex: getStageIndex("update"),
      stepCount: AUTO_STAGES.length,
      summary: summary.update,
    });
    return summary;
  }

  onProgress?.(createStageStartedEvent("run"));
  try {
    const runSummary = await runTranslations(
      repoDir,
      logger,
      (event) => {
        onProgress?.({
          type: "runProgress",
          stage: "run",
          event,
        });
      },
      signal,
      {
        onDebug: options.onDebug,
      },
    );
    summary.run = {
      stage: "run",
      status: runSummary.failureCount > 0 ? "partial" : "ok",
      summary: runSummary,
    };
    onProgress?.({
      type: "stageCompleted",
      stage: "run",
      stepIndex: getStageIndex("run"),
      stepCount: AUTO_STAGES.length,
      summary: summary.run,
    });
  } catch (error) {
    rethrowIfAborted(error, signal);
    const message = toErrorMessage(error);
    summary.run = {
      stage: "run",
      status: "failed",
      error: message,
    };
    summary.blockingError = {
      stage: "run",
      message,
    };
    onProgress?.({
      type: "stageFailed",
      stage: "run",
      stepIndex: getStageIndex("run"),
      stepCount: AUTO_STAGES.length,
      summary: summary.run,
    });
    return summary;
  }

  onProgress?.(createStageStartedEvent("apply"));
  try {
    const applySummary = await applyTranslations(repoDir, logger, {
      profile: options.profile,
    });
    summary.apply = {
      stage: "apply",
      status: "ok",
      summary: applySummary,
      profile: applySummary.profile,
    };
    onProgress?.({
      type: "stageCompleted",
      stage: "apply",
      stepIndex: getStageIndex("apply"),
      stepCount: AUTO_STAGES.length,
      summary: summary.apply,
    });
  } catch (error) {
    rethrowIfAborted(error, signal);
    const message = toErrorMessage(error);
    summary.apply = {
      stage: "apply",
      status: "failed",
      error: message,
      profile: extractCommandProfile(error),
    };
    summary.blockingError = {
      stage: "apply",
      message,
    };
    onProgress?.({
      type: "stageFailed",
      stage: "apply",
      stepIndex: getStageIndex("apply"),
      stepCount: AUTO_STAGES.length,
      summary: summary.apply,
    });
    return summary;
  }

  onProgress?.(createStageStartedEvent("build"));
  try {
    const buildSummary = await buildMirror(repoDir, logger, {
      profile: options.profile,
    });
    summary.build = {
      stage: "build",
      status: "ok",
      summary: buildSummary,
      profile: buildSummary.profile,
    };
    onProgress?.({
      type: "stageCompleted",
      stage: "build",
      stepIndex: getStageIndex("build"),
      stepCount: AUTO_STAGES.length,
      summary: summary.build,
    });
  } catch (error) {
    rethrowIfAborted(error, signal);
    const message = toErrorMessage(error);
    summary.build = {
      stage: "build",
      status: "failed",
      error: message,
      profile: extractCommandProfile(error),
    };
    summary.blockingError = {
      stage: "build",
      message,
    };
    onProgress?.({
      type: "stageFailed",
      stage: "build",
      stepIndex: getStageIndex("build"),
      stepCount: AUTO_STAGES.length,
      summary: summary.build,
    });
    return summary;
  }

  summary.ok =
    summary.update.status === "ok" &&
    summary.run.status === "ok" &&
    summary.apply.status === "ok" &&
    summary.build.status === "ok";
  return summary;
}

function createStageStartedEvent(
  stage: AutoPipelineStage,
): Extract<AutoPipelineProgressEvent, { type: "stageStarted" }> {
  return {
    type: "stageStarted",
    stage,
    stepIndex: getStageIndex(stage),
    stepCount: AUTO_STAGES.length,
  };
}

function getStageIndex(stage: AutoPipelineStage): number {
  return AUTO_STAGES.indexOf(stage) + 1;
}

function createSkippedUpdateSummary(): AutoUpdateStageSummary {
  return {
    stage: "update",
    status: "skipped",
  };
}

function createSkippedRunSummary(): AutoRunStageSummary {
  return {
    stage: "run",
    status: "skipped",
  };
}

function createSkippedApplySummary(): AutoApplyStageSummary {
  return {
    stage: "apply",
    status: "skipped",
  };
}

function createSkippedBuildSummary(): AutoBuildStageSummary {
  return {
    stage: "build",
    status: "skipped",
  };
}

function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw error;
  }

  if (error instanceof Error && error.name === "AbortError") {
    throw error;
  }
}

function shouldFailAutoCrawl(
  summary: NonNullable<AutoUpdateStageSummary["crawl"]>,
): boolean {
  return (
    summary.pageCount === 0 &&
    summary.assetCount === 0 &&
    (summary.stats.pageFailures > 0 || summary.stats.skippedByRobots > 0)
  );
}

function formatAutoFatalCrawlMessage(
  summary: NonNullable<AutoUpdateStageSummary["crawl"]>,
): string {
  const reasons: string[] = [];

  if (summary.stats.pageFailures > 0) {
    reasons.push(`${summary.stats.pageFailures} page failures`);
  }

  if (summary.stats.skippedByRobots > 0) {
    reasons.push(
      `${summary.stats.skippedByRobots} pages blocked by robots.txt`,
    );
  }

  if (summary.stats.robotsFailures > 0) {
    reasons.push(`${summary.stats.robotsFailures} robots.txt fallbacks`);
  }

  const firstIssue = summary.issues[0];
  if (firstIssue) {
    reasons.push(`${firstIssue.url}: ${firstIssue.message}`);
  }

  return `Crawl produced no cached files${reasons.length > 0 ? `: ${reasons.join("; ")}` : ""}`;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
