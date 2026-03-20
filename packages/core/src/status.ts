import { getRepoPaths } from "./repo-paths";
import { loadManifest, loadSegments, loadTranslations } from "./storage";
import { refreshTranslationTaskManifest } from "./translate";
import type { MirrorStatus } from "./types";

export async function getMirrorStatus(repoDir: string): Promise<MirrorStatus> {
  const paths = getRepoPaths(repoDir);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const translations = await loadTranslations(paths);
  const taskManifest = await refreshTranslationTaskManifest(repoDir);

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
    pendingTaskCount: taskManifest.summary.pending,
    inProgressTaskCount: taskManifest.summary.inProgress,
    doneTaskCount: taskManifest.summary.done,
    appliedTaskCount: taskManifest.summary.applied,
    invalidTaskCount: taskManifest.summary.invalid,
    expiredLeaseTaskCount: taskManifest.tasks.filter(
      (task) => task.status === "in-progress" && task.leaseExpired,
    ).length,
  };
}
