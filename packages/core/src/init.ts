import { join } from "pathe";

import type { Manifest } from "@documirror/shared";
import {
  createTimestamp,
  defaultLogger,
  manifestSchema,
  mirrorConfigSchema,
  translationTaskManifestSchema,
} from "@documirror/shared";
import {
  createDefaultConfig,
  createDefaultAiConfig,
  createMirrorRepoAgents,
  createMirrorRepoPackageJson,
  createMirrorRepoReadme,
  createTaskGuide,
  createTaskQueuePlaceholder,
} from "@documirror/templates";

import {
  ensureGitIgnoreEntry,
  upsertEnvVar,
  writeEnvTemplateIfMissing,
} from "./ai-config";
import { getRepoPaths } from "./repo-paths";
import {
  writeScaffoldJsonIfMissing,
  writeOrMergeScaffoldJson,
  writeScaffoldTextIfMissing,
} from "./scaffolding";
import { ensureRepoStructure } from "./storage";
import type { InitOptions } from "./types";

export async function initMirrorRepository(
  options: InitOptions,
): Promise<void> {
  const { repoDir, siteUrl, targetLocale, authToken = "" } = options;
  const logger = options.logger ?? defaultLogger;
  const paths = getRepoPaths(repoDir);

  await ensureRepoStructure(paths);

  const config = mirrorConfigSchema.parse(
    createDefaultConfig(
      siteUrl,
      targetLocale,
      options.ai ?? createDefaultAiConfig(),
    ),
  );
  const manifest: Manifest = manifestSchema.parse({
    sourceUrl: config.sourceUrl,
    targetLocale: config.targetLocale,
    generatedAt: createTimestamp(),
    pages: {},
    assets: {},
  });

  await writeOrMergeScaffoldJson(paths.configPath, config, logger);
  await writeScaffoldJsonIfMissing(paths.manifestPath, manifest, logger);
  await writeScaffoldJsonIfMissing(paths.assemblyPath, [], logger);
  await writeScaffoldJsonIfMissing(paths.glossaryPath, [], logger);
  await writeScaffoldJsonIfMissing(
    paths.taskManifestPath,
    translationTaskManifestSchema.parse({
      schemaVersion: 1,
      generatedAt: createTimestamp(),
      sourceUrl: config.sourceUrl,
      targetLocale: config.targetLocale,
      summary: {
        total: 0,
        pending: 0,
        done: 0,
        applied: 0,
        invalid: 0,
      },
      tasks: [],
    }),
    logger,
  );
  await writeScaffoldTextIfMissing(paths.segmentsPath, "", logger);
  await writeScaffoldTextIfMissing(paths.translationsPath, "", logger);
  await writeScaffoldTextIfMissing(
    paths.taskQueuePath,
    createTaskQueuePlaceholder(),
    logger,
  );
  await writeScaffoldTextIfMissing(
    join(paths.docuRoot, "TASKS.md"),
    createTaskGuide(),
    logger,
  );
  await writeEnvTemplateIfMissing(
    paths.envPath,
    config.ai.authTokenEnvVar,
    logger,
  );
  await upsertEnvVar(paths.envPath, config.ai.authTokenEnvVar, authToken);
  await ensureGitIgnoreEntry(paths.gitIgnorePath, ".env");
  await writeOrMergeScaffoldJson(
    join(repoDir, "package.json"),
    createMirrorRepoPackageJson(siteUrl, targetLocale),
    logger,
  );
  await writeScaffoldTextIfMissing(
    join(repoDir, "README.md"),
    createMirrorRepoReadme(siteUrl, targetLocale),
    logger,
  );
  await writeScaffoldTextIfMissing(
    join(repoDir, "AGENTS.md"),
    createMirrorRepoAgents(siteUrl, targetLocale),
    logger,
  );
  logger.info(`Initialized mirror repository in ${repoDir}`);
}
