import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";
import type { TranslationTaskManifest } from "@documirror/shared";

import { getRepoPaths } from "../../repo-paths";
import { loadConfig } from "../../storage";
import { syncTaskManifest } from "../services/task-manifest";

export async function refreshTranslationTaskManifest(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<TranslationTaskManifest> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  return syncTaskManifest(
    repoDir,
    paths,
    config.sourceUrl,
    config.targetLocale,
    logger,
  );
}
