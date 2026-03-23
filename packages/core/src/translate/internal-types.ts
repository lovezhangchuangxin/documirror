import type { TranslationTaskUnit } from "@documirror/parser";
import type {
  SegmentRecord,
  TranslationDraftResultFile,
  TranslationInlineGroupPlan,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
  TranslationVerificationIssue,
} from "@documirror/shared";
import type { PageChunkPlan, PlannedPageChunk } from "../page-chunking";

export type PlannedPageTask = {
  pageUrl: string;
  units: TranslationTaskUnit[];
};

export type RetainPendingTasksResult = {
  retainedPageUrls: Set<string>;
  retainedTaskCount: number;
  invalidatedTaskIds: string[];
};

export type RunFailureReport = {
  schemaVersion: 1;
  taskId: string;
  failedAt: string;
  attemptCount: number;
  chunk?: {
    chunkId: string;
    chunkIndex: number;
    chunkCount: number;
    itemStart: number;
    itemEnd: number;
    headingText?: string;
  };
  resultPreview?: string;
  errors: TranslationVerificationIssue[];
  message: string;
};

export type CandidateVerification = {
  ok: boolean;
  errors: TranslationVerificationIssue[];
  warnings: TranslationVerificationIssue[];
};

export type InlineGroupPlanBuildResult =
  | {
      ok: true;
      plan: TranslationInlineGroupPlan;
      projectedSegmentTexts: string[];
      foundInlineCodeSpans: string[];
    }
  | {
      ok: false;
      reason: string;
      foundInlineCodeSpans: string[];
    };

export type RunTaskViewResult = {
  draft: TranslationDraftResultFile;
  verification: CandidateVerification;
};

export type PreparedTaskRunChunkDraft = {
  chunk: PlannedPageChunk;
  draft: TranslationDraftResultFile;
  originalIds: string[];
};

export type PreparedTaskRunSession = {
  taskId: string;
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
  chunkPlan: PageChunkPlan;
  pendingChunkIndices: number[];
  chunkDrafts: PreparedTaskRunChunkDraft[];
};

export type PreparedApplyTaskBundle = {
  filePath: string;
  result: TranslationResultFile;
  mapping: TranslationTaskMappingFile;
};

export type RunTaskSnapshot = {
  completed: number;
  successCount: number;
  failureCount: number;
  total: number;
};

export type SegmentIndex = Map<string, SegmentRecord>;
