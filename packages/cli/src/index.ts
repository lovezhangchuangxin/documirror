#!/usr/bin/env node

import process from "node:process";

import {
  applyTranslations,
  buildMirror,
  claimTranslationTask,
  completeTranslationTask,
  crawlMirror,
  doctorMirror,
  extractMirror,
  getMirrorStatus,
  initMirrorRepository,
  planTranslations,
  verifyTranslationTask,
  updateMirror,
} from "@documirror/core";
import type { Logger } from "@documirror/shared";
import { Command } from "commander";
import ora from "ora";
import pc from "picocolors";

import {
  formatCrawlOutput,
  formatFatalCrawlMessage,
  shouldFailCrawl,
  type CommandOutput,
} from "./crawl-output";

const program = new Command();

program
  .name("documirror")
  .description("Mirror and translate static documentation sites")
  .version("0.1.0");

program
  .command("init")
  .argument("<site-url>", "source documentation site url")
  .requiredOption("--locale <locale>", "target locale, for example zh-CN")
  .option("--dir <dir>", "target repository directory", process.cwd())
  .action(async (siteUrl, options) => {
    await runWithSpinner(
      "Initializing mirror repository",
      async ({ logger }) => {
        await initMirrorRepository({
          repoDir: options.dir,
          siteUrl,
          targetLocale: options.locale,
          logger,
        });
        return `Initialized ${options.dir}`;
      },
    );
  });

program
  .command("crawl")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner(
      "Crawling source site",
      async ({ logger, setText, signal }) => {
        const summary = await crawlMirror(
          options.repo,
          logger,
          (progress) => {
            setText(
              formatCrawlProgress(progress.pageCount, progress.assetCount),
            );
          },
          signal,
        );
        if (shouldFailCrawl(summary)) {
          throw new Error(formatFatalCrawlMessage(summary));
        }

        return formatCrawlOutput(summary);
      },
    );
  });

program
  .command("extract")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner(
      "Extracting translatable content",
      async ({ logger }) => {
        const summary = await extractMirror(options.repo, logger);
        return `Extracted ${summary.segmentCount} segments from ${summary.pageCount} pages`;
      },
    );
  });

const translate = program
  .command("translate")
  .description("Manage translation tasks");

translate
  .command("plan")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Planning translation tasks", async ({ logger }) => {
      const summary = await planTranslations(options.repo, logger);
      return `Created ${summary.taskCount} page tasks for ${summary.segmentCount} segments`;
    });
  });

translate
  .command("claim")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .option("--task <taskId>", "specific task id to claim")
  .action(async (options) => {
    await runWithSpinner("Claiming translation task", async ({ logger }) => {
      const summary = await claimTranslationTask(
        options.repo,
        {
          taskId: options.task,
        },
        logger,
      );
      return {
        message: `Claimed ${summary.taskId}`,
        details: [
          `task file: ${summary.taskFile}`,
          `draft result: ${summary.draftResultFile}`,
          `next: documirror translate verify --repo ${options.repo} --task ${summary.taskId}`,
        ],
      };
    });
  });

translate
  .command("verify")
  .requiredOption("--task <taskId>", "task id to verify")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Verifying translation draft", async ({ logger }) => {
      const summary = await verifyTranslationTask(
        options.repo,
        options.task,
        logger,
      );
      if (!summary.ok) {
        summary.errors.slice(0, 5).forEach((issue) => {
          console.error(`[${issue.code}] ${issue.jsonPath}: ${issue.message}`);
        });
        if (summary.errorCount > 5) {
          console.error(
            `... ${summary.errorCount - 5} more errors in ${summary.reportPath}`,
          );
        }
        throw new Error(
          `Verification failed for ${summary.taskId}: ${summary.errorCount} errors, report ${summary.reportPath}`,
        );
      }

      return {
        message: `Verified ${summary.taskId}`,
        details: [
          `report: ${summary.reportPath}`,
          `errors: ${summary.errorCount}`,
          `warnings: ${summary.warningCount}`,
        ],
      };
    });
  });

translate
  .command("complete")
  .requiredOption("--task <taskId>", "task id to complete")
  .requiredOption("--provider <provider>", "agent or provider name")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Completing translation task", async ({ logger }) => {
      const summary = await completeTranslationTask(
        options.repo,
        {
          taskId: options.task,
          provider: options.provider,
        },
        logger,
      );
      return {
        message: `Completed ${summary.taskId}`,
        details: [`result file: ${summary.resultFile}`],
      };
    });
  });

translate
  .command("apply")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Applying translation results", async ({ logger }) => {
      const summary = await applyTranslations(options.repo, logger);
      return `Applied ${summary.appliedSegments} segments from ${summary.appliedFiles} result files`;
    });
  });

program
  .command("build")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Building translated mirror", async ({ logger }) => {
      const summary = await buildMirror(options.repo, logger);
      return `Built ${summary.pageCount} pages and ${summary.assetCount} assets, missing ${summary.missingTranslations} translations`;
    });
  });

program
  .command("update")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner(
      "Running incremental update",
      async ({ logger, setText, signal }) => {
        const summary = await updateMirror(
          options.repo,
          logger,
          (progress) => {
            setText(
              `Running incremental update: ${formatCount(progress.pageCount, "page")}, ${formatCount(progress.assetCount, "asset")} crawled`,
            );
          },
          signal,
        );
        return `Update finished: ${summary.crawl.pageCount} pages crawled, ${summary.extract.segmentCount} segments extracted, ${summary.plan.taskCount} tasks created`;
      },
    );
  });

program
  .command("doctor")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Checking mirror health", async () => {
      const summary = await doctorMirror(options.repo);
      return `Doctor report written to ${summary.reportPath}, missing translations ${summary.missingTranslationCount}`;
    });
  });

program
  .command("status")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    const status = await getMirrorStatus(options.repo);
    console.log(pc.bold("DocuMirror Status"));
    console.log(`source: ${status.sourceUrl}`);
    console.log(`target locale: ${status.targetLocale}`);
    console.log(`pages: ${status.pageCount}`);
    console.log(`assets: ${status.assetCount}`);
    console.log(`segments: ${status.segmentCount}`);
    console.log(`accepted translations: ${status.acceptedTranslationCount}`);
    console.log(`stale translations: ${status.staleTranslationCount}`);
    console.log(`pending tasks: ${status.pendingTaskCount}`);
    console.log(`done tasks: ${status.doneTaskCount}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(message));
  process.exitCode = 1;
});

async function runWithSpinner(
  title: string,
  run: (controls: SpinnerControls) => Promise<string | CommandOutput>,
): Promise<void> {
  const spinner = ora({
    text: title,
    discardStdin: false,
  });
  const controller = new AbortController();
  const exitState = { code: 1 };
  let forcedExitTimer: NodeJS.Timeout | undefined;
  const controls = createSpinnerControls(spinner, controller.signal);

  const cleanupSignals = installSignalHandlers({
    title,
    spinner,
    controller,
    exitState,
    onForceExitScheduled(timer) {
      forcedExitTimer = timer;
    },
  });

  spinner.start();

  try {
    const result = await run(controls);
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const message = reason instanceof Error ? reason.message : String(reason);
      spinner.fail(message);
      process.exitCode = exitState.code;
      return;
    }

    const output: CommandOutput =
      typeof result === "string" ? { message: result, details: [] } : result;
    spinner.succeed(output.message);
    output.details.forEach((line: string) => console.log(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.fail(message);
    process.exitCode = exitState.code;
  } finally {
    cleanupSignals();
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
    }
  }
}

type SpinnerControls = {
  logger: Logger;
  setText: (message: string) => void;
  signal: AbortSignal;
};

function createSpinnerControls(
  spinner: ReturnType<typeof ora>,
  signal: AbortSignal,
): SpinnerControls {
  const setText = (message: string) => {
    spinner.text = message;
  };

  return {
    logger: {
      info(message) {
        setText(message);
      },
      warn(message) {
        persistSpinnerMessage(spinner, pc.yellow("!"), message);
      },
      error(message) {
        persistSpinnerMessage(spinner, pc.red("x"), message);
      },
    },
    setText,
    signal,
  };
}

function persistSpinnerMessage(
  spinner: ReturnType<typeof ora>,
  symbol: string,
  message: string,
): void {
  const activeText = spinner.text;
  spinner.stopAndPersist({ symbol, text: message });
  spinner.start(activeText);
}

function formatCrawlProgress(pageCount: number, assetCount: number): string {
  return `Crawling source site: ${formatCount(pageCount, "page")}, ${formatCount(assetCount, "asset")}`;
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function installSignalHandlers(options: {
  title: string;
  spinner: ReturnType<typeof ora>;
  controller: AbortController;
  exitState: { code: number };
  onForceExitScheduled: (timer: NodeJS.Timeout) => void;
}): () => void {
  const { title, spinner, controller, exitState, onForceExitScheduled } =
    options;

  const handleSignal = (signalName: NodeJS.Signals) => {
    const exitCode = signalToExitCode(signalName);
    exitState.code = exitCode;

    if (!controller.signal.aborted) {
      controller.abort(createInterruptError(signalName, title));
      spinner.text = `${title} (stopping...)`;
      const timer = setTimeout(() => {
        spinner.stop();
        process.exit(exitCode);
      }, 5_000);
      timer.unref();
      onForceExitScheduled(timer);
      return;
    }

    spinner.stop();
    process.exit(exitCode);
  };

  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}

function createInterruptError(
  signalName: NodeJS.Signals,
  title: string,
): Error {
  const action =
    signalName === "SIGINT"
      ? "Interrupted by Ctrl+C"
      : `Interrupted by ${signalName}`;
  const error = new Error(`${action}; ${title.toLowerCase()} cancelled`);
  error.name = "AbortError";
  return error;
}

function signalToExitCode(signalName: NodeJS.Signals): number {
  switch (signalName) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    default:
      return 1;
  }
}
