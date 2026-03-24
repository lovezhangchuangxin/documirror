import { describe, expect, it } from "vitest";

import type { AutoPipelineSummary } from "@documirror/core";

import {
  formatAutoCompletionMessage,
  formatAutoFinalSummary,
  formatAutoRunProgress,
  formatAutoStageSummary,
  formatAutoUpdateProgress,
} from "../auto-output";
import { createRunProgressState } from "../run-progress";

describe("auto command output formatting", () => {
  it("formats update and run progress with auto stage headers", () => {
    expect(formatAutoUpdateProgress(3, 5)).toContain(
      "Auto 1/4: update | crawled 3 pages, 5 assets",
    );

    const state = createRunProgressState(0);
    const progress = formatAutoRunProgress(state, 0);
    expect(progress).toContain("Auto 2/4: translate run");
    expect(progress).toContain(
      "Running automatic translation: no pending tasks",
    );
  });

  it("formats stage summaries and final success output", () => {
    const summary: AutoPipelineSummary = {
      ok: true,
      update: {
        stage: "update",
        status: "ok",
        crawl: {
          pageCount: 1,
          assetCount: 0,
          issueCount: 0,
          issues: [],
          stats: {
            pageFailures: 0,
            assetFailures: 0,
            skippedByRobots: 0,
            invalidLinks: 0,
            robotsFailures: 0,
            retriedRequests: 0,
            timedOutRequests: 0,
          },
        },
        extract: {
          pageCount: 1,
          segmentCount: 2,
        },
        plan: {
          taskCount: 1,
          segmentCount: 2,
        },
      },
      run: {
        stage: "run",
        status: "ok",
        summary: {
          totalTasks: 1,
          completedTasks: 1,
          successCount: 1,
          failureCount: 0,
          skippedCount: 0,
          reportDir: "reports/translation-run",
        },
      },
      apply: {
        stage: "apply",
        status: "ok",
        summary: {
          appliedFiles: 1,
          appliedSegments: 2,
          profile: {
            totalDurationMs: 20,
            steps: [
              {
                label: "discover done results",
                durationMs: 5,
              },
            ],
          },
        },
      },
      build: {
        stage: "build",
        status: "ok",
        summary: {
          pageCount: 1,
          assetCount: 0,
          missingTranslations: 0,
          profile: {
            totalDurationMs: 30,
            steps: [
              {
                label: "build pages",
                durationMs: 12,
              },
            ],
          },
        },
      },
    };

    expect(formatAutoStageSummary(summary.run)).toEqual([
      "translate run: ok | completed 1/1, 1 succeeded, 0 failed | reports: reports/translation-run",
    ]);
    expect(formatAutoCompletionMessage(summary)).toBe(
      "Auto pipeline finished successfully",
    );
    expect(formatAutoFinalSummary(summary)).toEqual([
      "Auto Summary",
      "update: ok | crawled 1 page, 0 assets | extracted 2 segments from 1 page | planned 1 task for 2 segments",
      "translate run: ok | completed 1/1, 1 succeeded, 0 failed | reports: reports/translation-run",
      "translate apply: ok | 1 result file, 2 segments applied",
      "build: ok | built 1 page, 0 assets, missing 0 translations",
    ]);
  });

  it("formats partial translation completion as a non-success outcome", () => {
    const summary: AutoPipelineSummary = {
      ok: false,
      update: {
        stage: "update",
        status: "ok",
        crawl: {
          pageCount: 1,
          assetCount: 0,
          issueCount: 0,
          issues: [],
          stats: {
            pageFailures: 0,
            assetFailures: 0,
            skippedByRobots: 0,
            invalidLinks: 0,
            robotsFailures: 0,
            retriedRequests: 0,
            timedOutRequests: 0,
          },
        },
        extract: {
          pageCount: 1,
          segmentCount: 2,
        },
        plan: {
          taskCount: 1,
          segmentCount: 2,
        },
      },
      run: {
        stage: "run",
        status: "partial",
        summary: {
          totalTasks: 1,
          completedTasks: 1,
          successCount: 0,
          failureCount: 1,
          skippedCount: 0,
          reportDir: "reports/translation-run",
        },
      },
      apply: {
        stage: "apply",
        status: "ok",
        summary: {
          appliedFiles: 0,
          appliedSegments: 0,
        },
      },
      build: {
        stage: "build",
        status: "ok",
        summary: {
          pageCount: 1,
          assetCount: 0,
          missingTranslations: 2,
        },
      },
    };

    expect(formatAutoCompletionMessage(summary)).toBe(
      "Auto pipeline finished with translation failures; built site from partial results",
    );
  });
});
