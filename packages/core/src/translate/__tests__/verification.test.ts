import { describe, expect, it } from "vitest";

import type {
  SegmentRecord,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
} from "@documirror/shared";

import { verifyCandidateResult } from "../domain/verification";

const baseTask: TranslationTaskFile = {
  schemaVersion: 2,
  taskId: "task_verify",
  sourceUrl: "https://docs.example.com/",
  targetLocale: "zh-CN",
  createdAt: "2026-03-21T00:00:00.000Z",
  instructions: {
    translateTo: "zh-CN",
    preserveFormatting: true,
    preservePlaceholders: true,
    preserveInlineCode: true,
    applyGlossary: true,
    noOmission: true,
    noAddition: true,
  },
  glossary: [],
  page: {
    url: "https://docs.example.com/",
  },
  content: [],
};

describe("translate verification", () => {
  it("reports glossary and inline-code violations", () => {
    const task: TranslationTaskFile = {
      ...baseTask,
      glossary: [{ source: "API", target: "接口" }],
      content: [{ id: "1", text: "Use the `snap` API" }],
    };
    const mapping: TranslationTaskMappingFile = {
      schemaVersion: 2,
      taskId: task.taskId,
      sourceUrl: task.sourceUrl,
      targetLocale: task.targetLocale,
      createdAt: task.createdAt,
      page: { url: task.page.url },
      items: [
        {
          id: "1",
          kind: "inline-code",
          segments: [{ segmentId: "seg-1", sourceHash: "hash-1" }],
          inlineCodeSpans: [{ text: "snap", domPath: "body.p.code[1]" }],
          textSlotIndices: [0],
        },
      ],
    };
    const result: TranslationResultFile = {
      schemaVersion: 2,
      taskId: task.taskId,
      provider: "openai",
      model: "gpt-4.1-mini",
      completedAt: "2026-03-21T00:00:00.000Z",
      translations: [{ id: "1", translatedText: "使用 snap API" }],
    };
    const segmentIndex = new Map<string, SegmentRecord>([
      [
        "seg-1",
        {
          segmentId: "seg-1",
          pageUrl: task.page.url,
          domPath: "body.p[1]",
          kind: "text",
          sourceText: "Use the `snap` API",
          normalizedText: "Use the snap API",
          sourceHash: "hash-1",
          reuseKey: "reuse-1",
          context: {
            tagName: "p",
          },
        },
      ],
    ]);

    const verification = verifyCandidateResult(
      task,
      mapping,
      segmentIndex,
      result,
    );

    expect(verification.ok).toBe(false);
    expect(verification.errors.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "inline_code_mismatch",
        "glossary_target_missing",
      ]),
    );
  });

  it("emits a warning for suspiciously identical translations", () => {
    const task: TranslationTaskFile = {
      ...baseTask,
      taskId: "task_identical",
      content: [{ id: "1", text: "Install" }],
    };
    const mapping: TranslationTaskMappingFile = {
      schemaVersion: 2,
      taskId: task.taskId,
      sourceUrl: task.sourceUrl,
      targetLocale: task.targetLocale,
      createdAt: task.createdAt,
      page: { url: task.page.url },
      items: [
        {
          id: "1",
          kind: "segment",
          segment: { segmentId: "seg-2", sourceHash: "hash-2" },
        },
      ],
    };
    const result: TranslationResultFile = {
      schemaVersion: 2,
      taskId: task.taskId,
      provider: "openai",
      model: "gpt-4.1-mini",
      completedAt: "2026-03-21T00:00:00.000Z",
      translations: [{ id: "1", translatedText: "Install" }],
    };
    const segmentIndex = new Map<string, SegmentRecord>([
      [
        "seg-2",
        {
          segmentId: "seg-2",
          pageUrl: task.page.url,
          domPath: "body.p[1]",
          kind: "text",
          sourceText: "Install",
          normalizedText: "Install",
          sourceHash: "hash-2",
          reuseKey: "reuse-2",
          context: {
            tagName: "p",
          },
        },
      ],
    ]);

    const verification = verifyCandidateResult(
      task,
      mapping,
      segmentIndex,
      result,
    );

    expect(verification.errors).toHaveLength(0);
    expect(verification.warnings.map((issue) => issue.code)).toContain(
      "translation_suspiciously_identical",
    );
  });
});
