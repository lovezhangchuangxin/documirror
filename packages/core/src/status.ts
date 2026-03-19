import fg from "fast-glob";

import { getRepoPaths } from "./repo-paths";
import { loadManifest, loadSegments, loadTranslations } from "./storage";
import type { MirrorStatus } from "./types";

export async function getMirrorStatus(repoDir: string): Promise<MirrorStatus> {
  const paths = getRepoPaths(repoDir);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const translations = await loadTranslations(paths);
  const pendingTasks = await fg("*.json", { cwd: paths.tasksPendingDir });
  const doneTasks = await fg("*.json", { cwd: paths.tasksDoneDir });

  return {
    sourceUrl: manifest.sourceUrl,
    targetLocale: manifest.targetLocale,
    pageCount: Object.keys(manifest.pages).length,
    assetCount: Object.keys(manifest.assets).length,
    segmentCount: segments.length,
    acceptedTranslationCount: translations.filter(
      (translation) => translation.status === "accepted",
    ).length,
    staleTranslationCount: translations.filter(
      (translation) => translation.status === "stale",
    ).length,
    pendingTaskCount: pendingTasks.length,
    doneTaskCount: doneTasks.length,
  };
}
