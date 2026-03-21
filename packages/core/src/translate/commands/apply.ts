import type { Logger } from "@documirror/shared";
import {
  attachCommandProfile,
  createCommandProfileRecorder,
  defaultLogger,
} from "@documirror/shared";

import { getRepoPaths } from "../../repo-paths";
import {
  loadConfig,
  loadSegments,
  loadTranslations,
  writeJsonl,
} from "../../storage";
import type { ApplySummary, ApplyTranslationsOptions } from "../../types";
import {
  archiveDoneResultFile,
  archivePendingTaskFile,
  archiveTaskMapping,
  createArchiveStamp,
  listTaskFiles,
} from "../infra/task-repository";
import { resolveFileIoConcurrency } from "../runtime-utils";
import {
  prepareApplyTaskBundle,
  applyMappedTranslation,
} from "../services/task-applier";
import { syncTaskManifest } from "../services/task-manifest";

export async function applyTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
  options: ApplyTranslationsOptions = {},
): Promise<ApplySummary> {
  const profiler = createCommandProfileRecorder(options.profile);
  const paths = getRepoPaths(repoDir);
  let loadAndVerifyDurationMs = 0;
  let applyAndArchiveDurationMs = 0;
  let processDurationsRecorded = false;

  const recordProcessDurations = () => {
    if (processDurationsRecorded) {
      return;
    }

    profiler.record("load and verify results", loadAndVerifyDurationMs);
    profiler.record(
      "apply translations and archive tasks",
      applyAndArchiveDurationMs,
    );
    processDurationsRecorded = true;
  };

  try {
    const config = await loadConfig(paths);
    const segments = await loadSegments(paths);
    const segmentIndex = new Map(
      segments.map((segment) => [segment.segmentId, segment]),
    );
    const translations = await loadTranslations(paths);
    const translationIndex = new Map(
      translations.map((translation) => [translation.segmentId, translation]),
    );
    const files = await profiler.measure("discover done results", async () =>
      listTaskFiles(paths.tasksDoneDir, "*.json"),
    );

    let appliedFiles = 0;
    let appliedSegments = 0;
    const batchSize = resolveFileIoConcurrency();

    for (let index = 0; index < files.length; index += batchSize) {
      const batchFiles = files.slice(index, index + batchSize);
      let preparedBundles = [];
      const loadStartedAt = Date.now();
      try {
        preparedBundles = await Promise.all(
          batchFiles.map((filePath) =>
            prepareApplyTaskBundle({
              filePath,
              paths,
              segmentIndex,
              logger,
            }),
          ),
        );
      } finally {
        loadAndVerifyDurationMs += Date.now() - loadStartedAt;
      }

      const applyStartedAt = Date.now();
      try {
        for (const preparedBundle of preparedBundles) {
          if (!preparedBundle) {
            continue;
          }

          const { filePath, result, mapping } = preparedBundle;
          const mappingIndex = new Map(
            mapping.items.map((item) => [item.id, item]),
          );
          for (const item of result.translations) {
            const mappedItem = mappingIndex.get(item.id);
            if (!mappedItem) {
              logger.warn(
                `Skipping unknown translation id ${item.id} in ${filePath}`,
              );
              continue;
            }

            const appliedCount = applyMappedTranslation({
              mappedItem,
              translatedText: item.translatedText,
              targetLocale: config.targetLocale,
              provider: `${result.provider}/${result.model}`,
              completedAt: result.completedAt,
              filePath,
              segmentIndex,
              translationIndex,
              logger,
            });
            appliedSegments += appliedCount;
          }

          const archiveStamp = createArchiveStamp(result.completedAt);
          await Promise.all([
            archivePendingTaskFile(paths, result.taskId, archiveStamp),
            archiveTaskMapping(result.taskId, paths, archiveStamp),
            archiveDoneResultFile(paths, result.taskId, filePath, archiveStamp),
          ]);
          appliedFiles += 1;
        }
      } finally {
        applyAndArchiveDurationMs += Date.now() - applyStartedAt;
      }
    }

    recordProcessDurations();

    await profiler.measure("write translations state", async () =>
      writeJsonl(paths.translationsPath, [...translationIndex.values()]),
    );
    await profiler.measure("sync task manifest", async () =>
      syncTaskManifest(
        repoDir,
        paths,
        config.sourceUrl,
        config.targetLocale,
        logger,
      ),
    );
    return {
      appliedFiles,
      appliedSegments,
      profile: profiler.finish(),
    };
  } catch (error) {
    recordProcessDurations();
    throw attachCommandProfile(error, profiler.finish());
  }
}
