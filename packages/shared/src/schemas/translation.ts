import { z } from "zod";

export const translationStatusSchema = z.enum(["draft", "accepted", "stale"]);

export const translationRecordSchema = z.object({
  segmentId: z.string(),
  targetLocale: z.string(),
  translatedText: z.string(),
  sourceHash: z.string(),
  status: translationStatusSchema,
  provider: z.string(),
  updatedAt: z.string(),
});

export type TranslationRecord = z.infer<typeof translationRecordSchema>;

export const glossaryEntrySchema = z.object({
  source: z.string(),
  target: z.string(),
});

function validateUniqueIds<
  TItem extends {
    id: string;
  },
>(items: TItem[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "id"],
        message: `Duplicate id "${item.id}"`,
      });
      return;
    }

    seen.add(item.id);
  });
}

export const translationTaskContentItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  note: z.string().optional(),
});

export type TranslationTaskContentItem = z.infer<
  typeof translationTaskContentItemSchema
>;

export const translationTaskFileSchema = z.object({
  schemaVersion: z.literal(2),
  taskId: z.string(),
  sourceUrl: z.string(),
  targetLocale: z.string(),
  createdAt: z.string(),
  instructions: z.object({
    translateTo: z.string(),
    preserveFormatting: z.boolean(),
    preservePlaceholders: z.boolean(),
  }),
  glossary: z.array(glossaryEntrySchema).default([]),
  page: z.object({
    url: z.string(),
    title: z.string().optional(),
  }),
  content: z
    .array(translationTaskContentItemSchema)
    .superRefine(validateUniqueIds),
});

export type TranslationTaskFile = z.infer<typeof translationTaskFileSchema>;

export const translationResultItemSchema = z.object({
  id: z.string(),
  translatedText: z.string(),
});

export const translationResultFileSchema = z.object({
  schemaVersion: z.literal(2),
  taskId: z.string(),
  provider: z.string(),
  completedAt: z.string(),
  translations: z
    .array(translationResultItemSchema)
    .superRefine(validateUniqueIds),
});

export type TranslationResultFile = z.infer<typeof translationResultFileSchema>;

export const translationTaskMappingSegmentRefSchema = z.object({
  segmentId: z.string(),
  sourceHash: z.string(),
});

export type TranslationTaskMappingSegmentRef = z.infer<
  typeof translationTaskMappingSegmentRefSchema
>;

export const translationTaskMappingInlineCodeSpanSchema = z.object({
  text: z.string(),
});

export type TranslationTaskMappingInlineCodeSpan = z.infer<
  typeof translationTaskMappingInlineCodeSpanSchema
>;

const translationTaskMappingSegmentItemSchema = z.object({
  id: z.string(),
  kind: z.literal("segment"),
  segment: translationTaskMappingSegmentRefSchema,
});

const translationTaskMappingInlineCodeItemSchema = z
  .object({
    id: z.string(),
    kind: z.literal("inline-code"),
    segments: z.array(translationTaskMappingSegmentRefSchema).min(1),
    inlineCodeSpans: z.array(translationTaskMappingInlineCodeSpanSchema).min(1),
    textSlotIndices: z.array(z.number().int().nonnegative()).min(1),
  })
  .superRefine((item, ctx) => {
    if (item.segments.length !== item.textSlotIndices.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["textSlotIndices"],
        message:
          "inline-code items must contain one text slot index for each segment",
      });
    }

    const maxSlotIndex = item.inlineCodeSpans.length;
    item.textSlotIndices.forEach((slotIndex, index) => {
      if (slotIndex > maxSlotIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["textSlotIndices", index],
          message: `text slot index ${slotIndex} is out of range`,
        });
      }

      if (index > 0 && slotIndex <= item.textSlotIndices[index - 1]!) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["textSlotIndices", index],
          message: "text slot indices must be strictly increasing",
        });
      }
    });
  });

export const translationTaskMappingEntrySchema = z.discriminatedUnion("kind", [
  translationTaskMappingSegmentItemSchema,
  translationTaskMappingInlineCodeItemSchema,
]);

export type TranslationTaskMappingEntry = z.infer<
  typeof translationTaskMappingEntrySchema
>;

export const translationTaskMappingFileSchema = z.object({
  schemaVersion: z.literal(2),
  taskId: z.string(),
  sourceUrl: z.string(),
  targetLocale: z.string(),
  createdAt: z.string(),
  page: z.object({
    url: z.string(),
  }),
  items: z
    .array(translationTaskMappingEntrySchema)
    .superRefine(validateUniqueIds),
});

export type TranslationTaskMappingFile = z.infer<
  typeof translationTaskMappingFileSchema
>;
