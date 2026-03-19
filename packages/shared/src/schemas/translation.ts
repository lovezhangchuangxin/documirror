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

export const translationTaskItemSchema = z.object({
  segmentId: z.string(),
  sourceHash: z.string(),
  sourceText: z.string(),
  context: z.object({
    pageUrl: z.string(),
    domPath: z.string(),
    tagName: z.string(),
    pageTitle: z.string().optional(),
  }),
});

export type TranslationTaskItem = z.infer<typeof translationTaskItemSchema>;

export const glossaryEntrySchema = z.object({
  source: z.string(),
  target: z.string(),
});

export const translationTaskFileSchema = z.object({
  schemaVersion: z.literal(1),
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
  items: z.array(translationTaskItemSchema),
});

export type TranslationTaskFile = z.infer<typeof translationTaskFileSchema>;

export const translationResultItemSchema = z.object({
  segmentId: z.string(),
  sourceHash: z.string(),
  translatedText: z.string(),
});

export const translationResultFileSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: z.string(),
  provider: z.string(),
  completedAt: z.string(),
  items: z.array(translationResultItemSchema),
});

export type TranslationResultFile = z.infer<typeof translationResultFileSchema>;
