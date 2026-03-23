import type {
  CrawlIssue,
  CrawlProgress,
  CrawlStats,
} from "@documirror/crawler";
import type {
  CommandProfile,
  Logger,
  TranslationVerificationIssue,
} from "@documirror/shared";
import type { MirrorAiConfig } from "@documirror/shared";

export type RepoPaths = {
  docuRoot: string;
  envPath: string;
  gitIgnorePath: string;
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
  tasksAppliedHistoryDir: string;
  reportsDir: string;
};

export type InitOptions = {
  repoDir: string;
  siteUrl: string;
  targetLocale: string;
  ai?: MirrorAiConfig;
  authToken?: string;
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

export type BuildMirrorOptions = {
  profile?: boolean;
};

export type BuildSummary = {
  pageCount: number;
  assetCount: number;
  missingTranslations: number;
  profile?: CommandProfile;
};

export type ApplyTranslationsOptions = {
  profile?: boolean;
};

export type ApplySummary = {
  appliedFiles: number;
  appliedSegments: number;
  profile?: CommandProfile;
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

export type RunTaskChunkProgress = {
  chunkIndex: number;
  chunkCount: number;
  itemStart: number;
  itemEnd: number;
  headingText?: string;
};

export type RunTranslationsProgressEvent =
  | {
      type: "queued";
      total: number;
      concurrency: number;
      provider: string;
      model: string;
      requestTimeoutMs: number;
    }
  | {
      type: "started";
      taskId: string;
      completed: number;
      total: number;
    }
  | {
      type: "attempt";
      taskId: string;
      attempt: number;
      maxAttempts: number;
      completed: number;
      total: number;
      chunk?: RunTaskChunkProgress;
    }
  | {
      type: "attemptCompleted";
      taskId: string;
      completed: number;
      total: number;
      chunk?: RunTaskChunkProgress;
    }
  | {
      type: "completed";
      taskId: string;
      completed: number;
      total: number;
      successCount: number;
      failureCount: number;
    }
  | {
      type: "failed";
      taskId: string;
      completed: number;
      total: number;
      successCount: number;
      failureCount: number;
      error: string;
      reportPath: string;
    };

export type RunSummary = {
  totalTasks: number;
  completedTasks: number;
  successCount: number;
  failureCount: number;
  skippedCount: number;
  reportDir: string;
};

export type RunTranslationsOptions = {
  onDebug?: (message: string) => void;
};

export type AutoPipelineStage = "update" | "run" | "apply" | "build";

export type AutoPipelineStageStatus = "ok" | "partial" | "failed" | "skipped";

export type AutoUpdateStageSummary = {
  stage: "update";
  status: "ok" | "failed" | "skipped";
  crawl?: CrawlSummary;
  extract?: ExtractSummary;
  plan?: PlanSummary;
  error?: string;
};

export type AutoRunStageSummary = {
  stage: "run";
  status: AutoPipelineStageStatus;
  summary?: RunSummary;
  error?: string;
};

export type AutoApplyStageSummary = {
  stage: "apply";
  status: "ok" | "failed" | "skipped";
  summary?: ApplySummary;
  profile?: CommandProfile;
  error?: string;
};

export type AutoBuildStageSummary = {
  stage: "build";
  status: "ok" | "failed" | "skipped";
  summary?: BuildSummary;
  profile?: CommandProfile;
  error?: string;
};

export type AutoPipelineStageSummary =
  | AutoUpdateStageSummary
  | AutoRunStageSummary
  | AutoApplyStageSummary
  | AutoBuildStageSummary;

export type AutoPipelineProgressEvent =
  | {
      type: "stageStarted";
      stage: AutoPipelineStage;
      stepIndex: number;
      stepCount: number;
    }
  | {
      type: "crawlProgress";
      stage: "update";
      progress: CrawlProgressUpdate;
    }
  | {
      type: "runProgress";
      stage: "run";
      event: RunTranslationsProgressEvent;
    }
  | {
      type: "stageCompleted";
      stage: AutoPipelineStage;
      stepIndex: number;
      stepCount: number;
      summary: AutoPipelineStageSummary;
    }
  | {
      type: "stageFailed";
      stage: AutoPipelineStage;
      stepIndex: number;
      stepCount: number;
      summary: AutoPipelineStageSummary;
    };

export type RunAutoPipelineOptions = {
  profile?: boolean;
  onDebug?: (message: string) => void;
};

export type AutoPipelineSummary = {
  ok: boolean;
  update: AutoUpdateStageSummary;
  run: AutoRunStageSummary;
  apply: AutoApplyStageSummary;
  build: AutoBuildStageSummary;
  blockingError?: {
    stage: AutoPipelineStage;
    message: string;
  };
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
  doneTaskCount: number;
  appliedTaskCount: number;
  invalidTaskCount: number;
};
