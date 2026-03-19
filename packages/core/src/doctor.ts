import fs from "fs-extra";
import { join } from "pathe";

import { createTimestamp } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import {
  loadManifest,
  loadSegments,
  loadTranslations,
  writeJson,
} from "./storage";
import type { DoctorSummary } from "./types";

export async function doctorMirror(repoDir: string): Promise<DoctorSummary> {
  const paths = getRepoPaths(repoDir);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const translations = await loadTranslations(paths);

  const currentSourceHashes = new Map(
    segments.map((segment) => [segment.segmentId, segment.sourceHash]),
  );
  const acceptedTranslations = translations.filter(
    (translation) =>
      translation.status === "accepted" &&
      currentSourceHashes.get(translation.segmentId) === translation.sourceHash,
  );
  const staleTranslations = translations.filter(
    (translation) =>
      translation.status === "stale" ||
      currentSourceHashes.get(translation.segmentId) !== translation.sourceHash,
  );
  const missingTranslationCount = segments.filter((segment) => {
    const translation = acceptedTranslations.find(
      (candidate) => candidate.segmentId === segment.segmentId,
    );
    return !translation;
  }).length;

  let missingSnapshotCount = 0;
  for (const page of Object.values(manifest.pages)) {
    if (!(await fs.pathExists(join(repoDir, page.snapshotPath)))) {
      missingSnapshotCount += 1;
    }
  }

  const report = {
    generatedAt: createTimestamp(),
    sourceUrl: manifest.sourceUrl,
    targetLocale: manifest.targetLocale,
    pageCount: Object.keys(manifest.pages).length,
    assetCount: Object.keys(manifest.assets).length,
    segmentCount: segments.length,
    translatedSegmentCount: acceptedTranslations.length,
    missingTranslationCount,
    staleTranslationCount: staleTranslations.length,
    missingSnapshotCount,
  };
  const reportPath = join(paths.reportsDir, "doctor-latest.json");
  await writeJson(reportPath, report);

  return {
    pageCount: report.pageCount,
    segmentCount: report.segmentCount,
    translatedSegmentCount: report.translatedSegmentCount,
    missingTranslationCount: report.missingTranslationCount,
    staleTranslationCount: report.staleTranslationCount,
    missingSnapshotCount: report.missingSnapshotCount,
    reportPath,
  };
}
