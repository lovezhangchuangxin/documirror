import type {
  TranslationDraftResultFile,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
} from "@documirror/shared";
import {
  createTimestamp,
  translationDraftResultFileSchema,
  translationResultFileSchema,
  translationTaskFileSchema,
  translationTaskMappingFileSchema,
} from "@documirror/shared";
import type { TranslationTaskUnit } from "@documirror/parser";

export function createTaskBundle(
  taskId: string,
  sourceUrl: string,
  targetLocale: string,
  units: TranslationTaskUnit[],
): {
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
} {
  if (units.length === 0) {
    throw new Error("Cannot create a task bundle without task units");
  }

  const firstSegment = units[0]?.segments[0];
  if (!firstSegment) {
    throw new Error("Task bundle requires at least one segment");
  }
  const pageUrl = firstSegment.pageUrl;
  const pageTitle = firstSegment.context.pageTitle;
  const allSegments = units.flatMap((unit) => unit.segments);
  if (allSegments.some((segment) => segment.pageUrl !== pageUrl)) {
    throw new Error("Task bundle units must belong to the same page");
  }

  const createdAt = createTimestamp();
  const content = units.map((unit, index) => ({
    id: String(index + 1),
    text: unit.text,
    note: createTaskNote(unit),
  }));

  return {
    task: translationTaskFileSchema.parse({
      schemaVersion: 2,
      taskId,
      sourceUrl,
      targetLocale,
      createdAt,
      instructions: {
        translateTo: targetLocale,
        preserveFormatting: true,
        preservePlaceholders: true,
        preserveInlineCode: true,
        applyGlossary: true,
        noOmission: true,
        noAddition: true,
      },
      glossary: [],
      page: {
        url: pageUrl,
        title: pageTitle,
      },
      content,
    }),
    mapping: translationTaskMappingFileSchema.parse({
      schemaVersion: 2,
      taskId,
      sourceUrl,
      targetLocale,
      createdAt,
      page: {
        url: pageUrl,
      },
      items: units.map((unit, index) => {
        const id = String(index + 1);
        if (unit.inlineCodeSpans.length === 0) {
          return {
            id,
            kind: "segment",
            segment: {
              segmentId: unit.segments[0].segmentId,
              sourceHash: unit.segments[0].sourceHash,
            },
          };
        }

        return {
          id,
          kind: "inline-code",
          segments: unit.segments.map((segment) => ({
            segmentId: segment.segmentId,
            sourceHash: segment.sourceHash,
          })),
          inlineCodeSpans: unit.inlineCodeSpans,
          textSlotIndices: unit.textSlotIndices,
        };
      }),
    }),
  };
}

export function parseResultFile(value: unknown): TranslationResultFile {
  return translationResultFileSchema.parse(value);
}

export function parseDraftResultFile(
  value: unknown,
): TranslationDraftResultFile {
  return translationDraftResultFileSchema.parse(value);
}

export function parseTaskFile(value: unknown): TranslationTaskFile {
  return translationTaskFileSchema.parse(value);
}

export function parseTaskMappingFile(
  value: unknown,
): TranslationTaskMappingFile {
  return translationTaskMappingFileSchema.parse(value);
}

function createTaskNote(unit: TranslationTaskUnit): string | undefined {
  if (unit.note) {
    return unit.note;
  }

  const [segment] = unit.segments;
  if (!segment || segment.kind === "text") {
    return undefined;
  }

  if (segment.kind === "attr") {
    return `<${segment.context.tagName}> @${segment.attributeName}`;
  }

  return `<${segment.context.tagName}> content`;
}
