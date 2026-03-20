import type {
  CrawlIssue,
  CrawlProgress,
  CrawlStats,
} from "@documirror/crawler";
import type { Logger, TranslationVerificationIssue } from "@documirror/shared";

export type RepoPaths = {
  docuRoot: string;
  configPath: string;
  manifestPath: string;
  assemblyPath: string;
  glossaryPath: string;
  taskManifestPath: string;
  taskQueuePath: string;
  taskMappingsDir: string;
  pagesCacheDir: string;
  assetsCacheDir: string;
  segmentsPath: string;
  translationsPath: string;
  tasksPendingDir: string;
  tasksInProgressDir: string;
  tasksDoneDir: string;
  tasksAppliedDir: string;
  reportsDir: string;
};

export type InitOptions = {
  repoDir: string;
  siteUrl: string;
  targetLocale: string;
  logger?: Logger;
};

export type CrawlSummary = {
  pageCount: number;
  assetCount: number;
  issueCount: number;
  issues: CrawlIssue[];
  stats: CrawlStats;
};

export type CrawlProgressUpdate = CrawlProgress;

export type ExtractSummary = {
  pageCount: number;
  segmentCount: number;
};

export type PlanSummary = {
  taskCount: number;
  segmentCount: number;
};

export type ApplySummary = {
  appliedFiles: number;
  appliedSegments: number;
};

export type ClaimSummary = {
  taskId: string;
  taskFile: string;
  draftResultFile: string;
  claimedBy: string;
  leaseUntil: string;
};

export type VerifySummary = {
  taskId: string;
  ok: boolean;
  reportPath: string;
  errorCount: number;
  warningCount: number;
  errors: TranslationVerificationIssue[];
  warnings: TranslationVerificationIssue[];
};

export type CompleteSummary = {
  taskId: string;
  resultFile: string;
};

export type ReleaseSummary = {
  taskId: string;
  removedDraft: boolean;
  wasExpired: boolean;
};

export type ReclaimExpiredSummary = {
  reclaimedTaskCount: number;
  taskIds: string[];
  removedDraftCount: number;
};

export type DoctorSummary = {
  pageCount: number;
  segmentCount: number;
  translatedSegmentCount: number;
  missingTranslationCount: number;
  staleTranslationCount: number;
  missingSnapshotCount: number;
  reportPath: string;
};

export type MirrorStatus = {
  sourceUrl: string;
  targetLocale: string;
  pageCount: number;
  assetCount: number;
  segmentCount: number;
  acceptedTranslationCount: number;
  staleTranslationCount: number;
  pendingTaskCount: number;
  inProgressTaskCount: number;
  doneTaskCount: number;
  appliedTaskCount: number;
  invalidTaskCount: number;
  expiredLeaseTaskCount: number;
};
