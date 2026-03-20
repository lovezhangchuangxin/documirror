#!/usr/bin/env node

import process from "node:process";

import {
  applyTranslations,
  buildMirror,
  crawlMirror,
  doctorMirror,
  extractMirror,
  getMirrorStatus,
  initMirrorRepository,
  planTranslations,
  updateMirror,
} from "@documirror/core";
import { defaultLogger } from "@documirror/shared";
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
    await runWithSpinner("Initializing mirror repository", async () => {
      await initMirrorRepository({
        repoDir: options.dir,
        siteUrl,
        targetLocale: options.locale,
        logger: defaultLogger,
      });
      return `Initialized ${options.dir}`;
    });
  });

program
  .command("crawl")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Crawling source site", async () => {
      const summary = await crawlMirror(options.repo, defaultLogger);
      if (shouldFailCrawl(summary)) {
        throw new Error(formatFatalCrawlMessage(summary));
      }

      return formatCrawlOutput(summary);
    });
  });

program
  .command("extract")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Extracting translatable content", async () => {
      const summary = await extractMirror(options.repo, defaultLogger);
      return `Extracted ${summary.segmentCount} segments from ${summary.pageCount} pages`;
    });
  });

const translate = program
  .command("translate")
  .description("Manage translation tasks");

translate
  .command("plan")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Planning translation tasks", async () => {
      const summary = await planTranslations(options.repo, defaultLogger);
      return `Created ${summary.taskCount} page tasks for ${summary.segmentCount} segments`;
    });
  });

translate
  .command("apply")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Applying translation results", async () => {
      const summary = await applyTranslations(options.repo, defaultLogger);
      return `Applied ${summary.appliedSegments} segments from ${summary.appliedFiles} result files`;
    });
  });

program
  .command("build")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Building translated mirror", async () => {
      const summary = await buildMirror(options.repo, defaultLogger);
      return `Built ${summary.pageCount} pages and ${summary.assetCount} assets, missing ${summary.missingTranslations} translations`;
    });
  });

program
  .command("update")
  .option("--repo <dir>", "mirror repository directory", process.cwd())
  .action(async (options) => {
    await runWithSpinner("Running incremental update", async () => {
      const summary = await updateMirror(options.repo, defaultLogger);
      return `Update finished: ${summary.crawl.pageCount} pages crawled, ${summary.extract.segmentCount} segments extracted, ${summary.plan.taskCount} tasks created`;
    });
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
  run: () => Promise<string | CommandOutput>,
): Promise<void> {
  const spinner = ora(title).start();
  try {
    const result = await run();
    const output: CommandOutput =
      typeof result === "string" ? { message: result, details: [] } : result;
    spinner.succeed(output.message);
    output.details.forEach((line: string) => console.log(line));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    spinner.fail(message);
    process.exitCode = 1;
  }
}
