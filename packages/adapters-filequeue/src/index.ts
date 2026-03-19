import type {
  SegmentRecord,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskItem,
} from "@documirror/shared";
import {
  createTimestamp,
  translationTaskFileSchema,
  translationResultFileSchema,
} from "@documirror/shared";

export function createTaskFile(
  taskId: string,
  sourceUrl: string,
  targetLocale: string,
  items: TranslationTaskItem[],
): TranslationTaskFile {
  return translationTaskFileSchema.parse({
    schemaVersion: 1,
    taskId,
    sourceUrl,
    targetLocale,
    createdAt: createTimestamp(),
    instructions: {
      translateTo: targetLocale,
      preserveFormatting: true,
      preservePlaceholders: true,
    },
    glossary: [],
    items,
  });
}

export function createTaskItems(
  segments: SegmentRecord[],
): TranslationTaskItem[] {
  return segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceHash: segment.sourceHash,
    sourceText: segment.sourceText,
    context: {
      pageUrl: segment.pageUrl,
      domPath: segment.domPath,
      tagName: segment.context.tagName,
      pageTitle: segment.context.pageTitle,
    },
  }));
}

export function parseResultFile(value: unknown): TranslationResultFile {
  return translationResultFileSchema.parse(value);
}

export function parseTaskFile(value: unknown): TranslationTaskFile {
  return translationTaskFileSchema.parse(value);
}
