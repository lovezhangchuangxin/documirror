import { z } from "zod";

export const assetRecordSchema = z.object({
  url: z.string(),
  cachePath: z.string(),
  outputPath: z.string(),
  contentType: z.string().optional(),
  contentHash: z.string(),
});

export type AssetRecord = z.infer<typeof assetRecordSchema>;

export const pageRecordSchema = z.object({
  url: z.string(),
  canonicalUrl: z.string(),
  status: z.number().int(),
  contentType: z.string(),
  snapshotPath: z.string(),
  outputPath: z.string(),
  pageHash: z.string(),
  discoveredFrom: z.string().nullable(),
  assetRefs: z.array(z.string()).default([]),
  extractedAt: z.string().optional(),
});

export type PageRecord = z.infer<typeof pageRecordSchema>;

export const manifestSchema = z.object({
  sourceUrl: z.string(),
  targetLocale: z.string(),
  generatedAt: z.string(),
  pages: z.record(z.string(), pageRecordSchema).default({}),
  assets: z.record(z.string(), assetRecordSchema).default({}),
});

export type Manifest = z.infer<typeof manifestSchema>;

export const segmentKindSchema = z.enum(["text", "attr", "meta"]);

export const segmentRecordSchema = z.object({
  segmentId: z.string(),
  reuseKey: z.string().optional(),
  pageUrl: z.string(),
  domPath: z.string(),
  kind: segmentKindSchema,
  attributeName: z.string().optional(),
  sourceText: z.string(),
  normalizedText: z.string(),
  sourceHash: z.string(),
  context: z.object({
    tagName: z.string(),
    pageTitle: z.string().optional(),
    surroundingText: z.string().optional(),
  }),
});

export type SegmentRecord = z.infer<typeof segmentRecordSchema>;

export const assemblyBindingSchema = z.object({
  segmentId: z.string(),
  domPath: z.string(),
  kind: segmentKindSchema,
  attributeName: z.string().optional(),
});

export type AssemblyBinding = z.infer<typeof assemblyBindingSchema>;

export const assemblyMapSchema = z.object({
  pageUrl: z.string(),
  bindings: z.array(assemblyBindingSchema),
});

export type AssemblyMap = z.infer<typeof assemblyMapSchema>;
