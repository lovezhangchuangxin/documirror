#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  applyTranslations,
  runAutoPipeline,
  buildMirror,
  crawlMirror,
  doctorMirror,
  extractMirror,
  getMirrorStatus,
  initMirrorRepository,
  runTranslations,
  resolveAiAuthToken,
  testAiConnection,
  updateMirror,
  verifyTranslationTask,
  planTranslations,
  saveMirrorAiConfig,
} from "@documirror/core";
import type {
  CommandProfile,
  Logger,
  MirrorAiConfig,
  MirrorConfig,
} from "@documirror/shared";
import { extractCommandProfile, mirrorConfigSchema } from "@documirror/shared";
import { Command } from "commander";
import ora from "ora";
import pc from "picocolors";
import prompts from "prompts";

import {
  applyRunProgressEvent,
  createRunProgressState,
  formatRunProgressMessage,
} from "./run-progress";
import {
  formatAutoCompletionMessage,
  formatAutoFinalSummary,
  formatAutoRunProgress,
  formatAutoStageSummary,
  formatAutoStageTitle,
  formatAutoUpdateProgress,
} from "./auto-output";
import {
  formatCrawlOutput,
  formatFatalCrawlMessage,
  shouldFailCrawl,
  type CommandOutput,
} from "./crawl-output";
import { normalizeCliArgv } from "./argv";

const program = new Command();

program
  .name("documirror")
  .description("Mirror and translate static documentation sites")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a new mirror repository")
  .option(
    "--repo <dir>",
    "target repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--site-url <url>", "source documentation site url")
  .option("--locale <locale>", "target locale, for example zh-CN")
  .option("--provider <provider>", "display name for the llm provider")
  .option("--base-url <url>", "openai-compatible api base url")
  .option("--model <model>", "model name")
  .option("--auth-token <token>", "api auth token")
  .option("--concurrency <count>", "translation concurrency", Number)
  .action(async (options) => {
    const initOptions = await collectInitOptions(options);
    await runWithSpinner(
      "Initializing mirror repository",
      async ({ logger, signal }) => {
        const connection = await testAiConnection(
          initOptions.ai,
          initOptions.authToken,
          signal,
        );
        if (!connection.ok) {
          throw new Error(`AI connection test failed: ${connection.message}`);
        }

        await initMirrorRepository({
          repoDir: initOptions.repoDir,
          siteUrl: initOptions.siteUrl,
          targetLocale: initOptions.targetLocale,
          ai: initOptions.ai,
          authToken: initOptions.authToken,
          logger,
        });
        return {
          message: `Initialized ${initOptions.repoDir}`,
          details: [
            `source: ${initOptions.siteUrl}`,
            `locale: ${initOptions.targetLocale}`,
            `model: ${initOptions.ai.llmProvider}/${initOptions.ai.modelName}`,
            connection.message,
          ],
        };
      },
    );
  });

const config = program.command("config").description("Manage configuration");

config
  .command("ai")
  .description("Configure AI model settings")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--provider <provider>", "display name for the llm provider")
  .option("--base-url <url>", "openai-compatible api base url")
  .option("--model <model>", "model name")
  .option("--auth-token <token>", "api auth token")
  .option("--concurrency <count>", "translation concurrency", Number)
  .action(async (options) => {
    const existing = await loadExistingConfig(options.repo);
    const currentAi = existing.ai;
    const existingAuthToken =
      typeof options.authToken === "string"
        ? options.authToken
        : await resolveAiAuthToken(options.repo, currentAi).catch(() => "");
    const answers = await promptAiConfig(
      {
        llmProvider: options.provider ?? currentAi.llmProvider,
        baseUrl: options.baseUrl ?? currentAi.baseUrl,
        modelName: options.model ?? currentAi.modelName,
        authToken:
          typeof options.authToken === "string" ? options.authToken : "",
        fallbackAuthToken: existingAuthToken,
        concurrency: options.concurrency ?? currentAi.concurrency,
        requestTimeoutMs: currentAi.requestTimeoutMs,
        maxAttemptsPerTask: currentAi.maxAttemptsPerTask,
        temperature: currentAi.temperature,
        authTokenEnvVar: currentAi.authTokenEnvVar,
        chunking: currentAi.chunking,
      },
      {
        title: "Configure AI model",
      },
    );
    await runWithSpinner(
      "Updating AI configuration",
      async ({ logger, signal }) => {
        const connection = await testAiConnection(
          answers.ai,
          answers.authToken,
          signal,
        );
        if (!connection.ok) {
          throw new Error(`AI connection test failed: ${connection.message}`);
        }

        await saveMirrorAiConfig(
          options.repo,
          answers.ai,
          answers.authToken,
          logger,
        );
        return {
          message: `Updated AI configuration for ${options.repo}`,
          details: [
            `model: ${answers.ai.llmProvider}/${answers.ai.modelName}`,
            connection.message,
          ],
        };
      },
    );
  });

program
  .command("crawl")
  .description("Crawl the source documentation site")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
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
  .description("Extract translatable content from crawled pages")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
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
  .description("Generate translation tasks for new or stale segments")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .action(async (options) => {
    await runWithSpinner("Planning translation tasks", async ({ logger }) => {
      const summary = await planTranslations(options.repo, logger);
      return `Created ${summary.taskCount} page tasks for ${summary.segmentCount} segments`;
    });
  });

translate
  .command("run")
  .description("Execute automatic translation using configured AI model")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--debug", "print per-task debug logs")
  .action(async (options) => {
    await runWithSpinner(
      "Running automatic translation",
      async ({ logger, setText, signal, persistInfo }) => {
        const progressState = createRunProgressState();
        const progressTimer = setInterval(() => {
          setText(formatRunProgressMessage(progressState));
        }, 1000);
        progressTimer.unref();
        const debugHeartbeatTimer = options.debug
          ? setInterval(() => {
              persistInfo(`[debug] ${formatRunProgressMessage(progressState)}`);
            }, 15_000)
          : undefined;
        debugHeartbeatTimer?.unref();

        try {
          const summary = await runTranslations(
            options.repo,
            logger,
            (event) => {
              applyRunProgressEvent(progressState, event);
              setText(formatRunProgressMessage(progressState));
              if (event.type === "failed") {
                logger.warn(
                  `${event.taskId} failed: ${event.error} (${event.reportPath})`,
                );
              }
            },
            signal,
            options.debug
              ? {
                  onDebug(message) {
                    persistInfo(`[debug] ${message}`);
                  },
                }
              : undefined,
          );
          if (summary.failureCount > 0) {
            throw new Error(
              `Automatic translation finished with ${summary.failureCount} failed task(s). See ${summary.reportDir}.`,
            );
          }

          return {
            message: `Finished automatic translation: ${summary.successCount} succeeded, ${summary.failureCount} failed`,
            details: [
              `completed: ${summary.completedTasks}/${summary.totalTasks}`,
              `failure reports: ${summary.reportDir}`,
            ],
          };
        } finally {
          clearInterval(progressTimer);
          if (debugHeartbeatTimer) {
            clearInterval(debugHeartbeatTimer);
          }
        }
      },
    );
  });

translate
  .command("verify")
  .description("Validate a translation result file")
  .requiredOption("--task <taskId>", "task id to verify")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--result <path>", "explicit result file to verify")
  .action(async (options) => {
    await runWithSpinner("Verifying translation result", async ({ logger }) => {
      const summary = await verifyTranslationTask(
        options.repo,
        options.task,
        {
          resultPath: options.result,
        },
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
  .command("apply")
  .description("Accept verified translation results")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--profile", "print stage timings")
  .action(async (options) => {
    await runWithSpinner(
      "Applying translation results",
      async ({ logger, persistInfo }) => {
        try {
          const summary = await applyTranslations(options.repo, logger, {
            profile: options.profile === true,
          });
          return {
            message: `Applied ${summary.appliedSegments} segments from ${summary.appliedFiles} result files`,
            details: formatProfileDetails(summary.profile),
          };
        } catch (error) {
          formatProfileDetails(extractCommandProfile(error)).forEach(
            persistInfo,
          );
          throw error;
        }
      },
    );
  });

program
  .command("auto")
  .description("Run update, automatic translation, apply, and build")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--debug", "print translate-run debug logs during the auto pipeline")
  .option("--profile", "print stage timings for apply and build")
  .action(async (options) => {
    await runWithSpinner(
      "Running automatic pipeline",
      async ({ logger, setText, signal, persistInfo }) => {
        const runProgressState = createRunProgressState();
        let runProgressTimer: NodeJS.Timeout | undefined;
        let runDebugHeartbeatTimer: NodeJS.Timeout | undefined;

        const clearRunTimers = () => {
          if (runProgressTimer) {
            clearInterval(runProgressTimer);
            runProgressTimer = undefined;
          }
          if (runDebugHeartbeatTimer) {
            clearInterval(runDebugHeartbeatTimer);
            runDebugHeartbeatTimer = undefined;
          }
        };

        try {
          const summary = await runAutoPipeline(
            options.repo,
            logger,
            (event) => {
              switch (event.type) {
                case "stageStarted":
                  setText(formatAutoStageTitle(event.stage));
                  if (event.stage === "run") {
                    const refresh = () => {
                      setText(formatAutoRunProgress(runProgressState));
                    };
                    refresh();
                    runProgressTimer = setInterval(refresh, 1000);
                    runProgressTimer.unref();
                    if (options.debug) {
                      runDebugHeartbeatTimer = setInterval(() => {
                        persistInfo(
                          `[run debug] ${formatRunProgressMessage(runProgressState)}`,
                        );
                      }, 15_000);
                      runDebugHeartbeatTimer.unref();
                    }
                  }
                  return;
                case "crawlProgress":
                  setText(
                    formatAutoUpdateProgress(
                      event.progress.pageCount,
                      event.progress.assetCount,
                    ),
                  );
                  return;
                case "runProgress":
                  applyRunProgressEvent(runProgressState, event.event);
                  setText(formatAutoRunProgress(runProgressState));
                  if (event.event.type === "failed") {
                    logger.warn(
                      `${event.event.taskId} failed: ${event.event.error} (${event.event.reportPath})`,
                    );
                  }
                  return;
                case "stageCompleted":
                  if (event.stage === "run") {
                    clearRunTimers();
                  }
                  formatAutoStageSummary(event.summary).forEach(persistInfo);
                  return;
                case "stageFailed":
                  if (event.stage === "run") {
                    clearRunTimers();
                  }
                  formatAutoStageSummary(event.summary).forEach(persistInfo);
                  return;
              }
            },
            signal,
            {
              profile: options.profile === true,
              onDebug: options.debug
                ? (message) => {
                    persistInfo(`[run debug] ${message}`);
                  }
                : undefined,
            },
          );

          const finalDetails = formatAutoFinalSummary(summary);
          if (!summary.ok) {
            finalDetails.forEach(persistInfo);
            throw new Error(formatAutoCompletionMessage(summary));
          }

          return {
            message: formatAutoCompletionMessage(summary),
            details: finalDetails,
          };
        } finally {
          clearRunTimers();
        }
      },
    );
  });

program
  .command("build")
  .description("Build the translated mirror site")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .option("--profile", "print stage timings")
  .action(async (options) => {
    await runWithSpinner(
      "Building translated mirror",
      async ({ logger, persistInfo }) => {
        try {
          const summary = await buildMirror(options.repo, logger, {
            profile: options.profile === true,
          });
          return {
            message: `Built ${summary.pageCount} pages and ${summary.assetCount} assets, missing ${summary.missingTranslations} translations`,
            details: formatProfileDetails(summary.profile),
          };
        } catch (error) {
          formatProfileDetails(extractCommandProfile(error)).forEach(
            persistInfo,
          );
          throw error;
        }
      },
    );
  });

program
  .command("update")
  .description("Run incremental crawl, extract, and plan")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
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
  .description("Check mirror health and diagnose issues")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
  .action(async (options) => {
    await runWithSpinner("Checking mirror health", async () => {
      const summary = await doctorMirror(options.repo);
      return `Doctor report written to ${summary.reportPath}, missing translations ${summary.missingTranslationCount}`;
    });
  });

program
  .command("status")
  .description("Show current mirror repository status")
  .option(
    "--repo <dir>",
    "mirror repository directory (defaults to current directory)",
    process.cwd(),
  )
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
    console.log(`applied tasks: ${status.appliedTaskCount}`);
    console.log(`invalid tasks: ${status.invalidTaskCount}`);
  });

program
  .parseAsync(
    normalizeCliArgv(process.argv, {
      stripForwardedOptionSeparator:
        process.env.npm_lifecycle_event !== undefined,
    }),
  )
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(pc.red(message));
    process.exitCode = 1;
  });

type InitAnswers = {
  repoDir: string;
  siteUrl: string;
  targetLocale: string;
  ai: MirrorAiConfig;
  authToken: string;
};

async function collectInitOptions(
  options: Record<string, unknown>,
): Promise<InitAnswers> {
  const initialAi = {
    llmProvider: String(options.provider ?? "openai"),
    baseUrl: String(options.baseUrl ?? "https://api.openai.com/v1"),
    modelName: String(options.model ?? "gpt-4.1-mini"),
    authToken: String(options.authToken ?? ""),
    fallbackAuthToken: "",
    concurrency:
      typeof options.concurrency === "number" &&
      !Number.isNaN(options.concurrency)
        ? options.concurrency
        : 4,
    requestTimeoutMs: 300_000,
    maxAttemptsPerTask: 3,
    temperature: 0.2,
    authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
    chunking: {
      enabled: true,
      strategy: "structural" as const,
      maxItemsPerChunk: 80,
      softMaxSourceCharsPerChunk: 6_000,
      hardMaxSourceCharsPerChunk: 9_000,
    },
  };
  const repoDir = String(options.repo ?? process.cwd());
  const siteUrl =
    typeof options.siteUrl === "string" ? options.siteUrl : undefined;
  const targetLocale =
    typeof options.locale === "string" ? options.locale : undefined;

  if (
    !process.stdin.isTTY &&
    (!siteUrl || !targetLocale || !initialAi.authToken)
  ) {
    throw new Error(
      "Non-interactive init requires --site-url, --locale, and --auth-token.",
    );
  }

  const answers: Record<string, string> = process.stdin.isTTY
    ? ((await prompts(
        [
          {
            type: siteUrl ? null : "text",
            name: "siteUrl",
            message: "Source documentation site URL",
            initial: "https://docs.example.com",
            validate: (value: string) =>
              value.startsWith("http") ? true : "Enter a valid URL.",
          },
          {
            type: targetLocale ? null : "text",
            name: "targetLocale",
            message: "Target locale",
            initial: "zh-CN",
          },
          {
            type: "text",
            name: "repoDir",
            message: "Repository directory",
            initial: repoDir,
          },
        ],
        {
          onCancel: () => {
            throw new Error("Initialization cancelled.");
          },
        },
      )) as Record<string, string>)
    : {};

  const aiAnswers = await promptAiConfig(initialAi, {
    title: "Configure AI model",
  });

  return {
    repoDir: String(answers.repoDir ?? repoDir),
    siteUrl: String(answers.siteUrl ?? siteUrl),
    targetLocale: String(answers.targetLocale ?? targetLocale),
    ai: aiAnswers.ai,
    authToken: aiAnswers.authToken,
  };
}

async function promptAiConfig(
  initial: {
    llmProvider: string;
    baseUrl: string;
    modelName: string;
    authToken: string;
    fallbackAuthToken: string;
    concurrency: number;
    requestTimeoutMs: number;
    maxAttemptsPerTask: number;
    temperature: number;
    authTokenEnvVar: string;
    chunking: MirrorAiConfig["chunking"];
  },
  options: {
    title: string;
  },
): Promise<{
  ai: MirrorAiConfig;
  authToken: string;
}> {
  const answers:
    | Record<string, string | number>
    | (typeof initial &
        Record<string, string | number | MirrorAiConfig["chunking"]>) = process
    .stdin.isTTY
    ? ((await prompts(
        [
          {
            type: "text",
            name: "llmProvider",
            message: `${options.title}: provider label`,
            initial: initial.llmProvider,
          },
          {
            type: "text",
            name: "baseUrl",
            message: "OpenAI-compatible base URL",
            initial: initial.baseUrl,
          },
          {
            type: "text",
            name: "modelName",
            message: "Model name",
            initial: initial.modelName,
          },
          {
            type: "password",
            name: "authToken",
            message: initial.fallbackAuthToken
              ? "API auth token (leave blank to keep existing)"
              : "API auth token",
            initial: initial.authToken,
          },
          {
            type: "number",
            name: "concurrency",
            message: "Translation concurrency",
            initial: initial.concurrency,
            min: 1,
            max: 32,
          },
          {
            type: "number",
            name: "requestTimeoutMs",
            message: "Request timeout (ms)",
            initial: initial.requestTimeoutMs,
            min: 1_000,
            max: 300_000,
          },
        ],
        {
          onCancel: () => {
            throw new Error("Configuration cancelled.");
          },
        },
      )) as Record<string, string | number>)
    : initial;

  const authToken =
    String(answers.authToken ?? initial.authToken).trim() ||
    initial.fallbackAuthToken.trim();
  if (!authToken) {
    throw new Error("API auth token is required.");
  }

  return {
    ai: {
      providerKind: "openai-compatible",
      llmProvider: String(answers.llmProvider ?? initial.llmProvider),
      baseUrl: String(answers.baseUrl ?? initial.baseUrl),
      modelName: String(answers.modelName ?? initial.modelName),
      authTokenEnvVar: initial.authTokenEnvVar,
      concurrency: Number(answers.concurrency ?? initial.concurrency),
      requestTimeoutMs: Number(
        answers.requestTimeoutMs ?? initial.requestTimeoutMs,
      ),
      maxAttemptsPerTask: initial.maxAttemptsPerTask,
      temperature: initial.temperature,
      chunking: initial.chunking,
    },
    authToken,
  };
}

async function loadExistingConfig(repoDir: string): Promise<MirrorConfig> {
  const body = await readFile(
    join(repoDir, ".documirror", "config.json"),
    "utf8",
  );
  return mirrorConfigSchema.parse(JSON.parse(body));
}

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
  persistInfo: (message: string) => void;
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
    persistInfo(message) {
      persistSpinnerMessage(spinner, pc.cyan(">"), message);
    },
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

function formatProfileDetails(profile: CommandProfile | undefined): string[] {
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
