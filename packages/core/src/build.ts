import { buildSite } from "@documirror/site-builder";
import type { Logger } from "@documirror/shared";
import { defaultLogger } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import {
  loadAssemblyMaps,
  loadConfig,
  loadManifest,
  loadSegments,
  loadTranslations,
} from "./storage";

export async function buildMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<Awaited<ReturnType<typeof buildSite>>> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const assemblyMaps = await loadAssemblyMaps(paths);
  const translations = await loadTranslations(paths);

  return buildSite({
    repoDir,
    config,
    manifest,
    segments,
    assemblyMaps,
    translations,
    logger,
  });
}
