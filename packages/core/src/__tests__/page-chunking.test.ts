import { describe, expect, it } from "vitest";

import type {
  MirrorAiChunkingConfig,
  SegmentRecord,
  TranslationTaskFile,
  TranslationTaskMappingFile,
} from "@documirror/shared";

import { planPageChunks } from "../page-chunking";

function createSegment(
  segmentId: string,
  tagName: string,
  sourceText: string,
): SegmentRecord {
  return {
    segmentId,
    pageUrl: "https://docs.example.com/page",
    domPath: `root[0]/${tagName}[0]/#text[0]`,
    kind: "text",
    sourceText,
    normalizedText: sourceText,
    sourceHash: `${segmentId}-hash`,
    context: {
      tagName,
      pageTitle: "Docs",
    },
  };
}

function createChunkingConfig(
  overrides: Partial<MirrorAiChunkingConfig> = {},
): MirrorAiChunkingConfig {
  return {
    enabled: true,
    strategy: "structural",
    maxItemsPerChunk: 10,
    softMaxSourceCharsPerChunk: 80,
    hardMaxSourceCharsPerChunk: 1_000,
    ...overrides,
  };
}

describe("page chunk planning", () => {
  it("splits a single large section by the soft char limit", () => {
    const task: TranslationTaskFile = {
      schemaVersion: 2,
      taskId: "task_page",
      sourceUrl: "https://docs.example.com",
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
        url: "https://docs.example.com/page",
        title: "Docs",
      },
      content: [
        {
          id: "1",
          text: "Install",
        },
        {
          id: "2",
          text: "A".repeat(40),
        },
        {
          id: "3",
          text: "B".repeat(40),
        },
        {
          id: "4",
          text: "C".repeat(40),
        },
      ],
    };
    const mapping: TranslationTaskMappingFile = {
      schemaVersion: 2,
      taskId: "task_page",
      sourceUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      createdAt: "2026-03-21T00:00:00.000Z",
      page: {
        url: "https://docs.example.com/page",
      },
      items: [
        {
          id: "1",
          kind: "segment",
          segment: {
            segmentId: "seg-1",
            sourceHash: "seg-1-hash",
          },
        },
        {
          id: "2",
          kind: "segment",
          segment: {
            segmentId: "seg-2",
            sourceHash: "seg-2-hash",
          },
        },
        {
          id: "3",
          kind: "segment",
          segment: {
            segmentId: "seg-3",
            sourceHash: "seg-3-hash",
          },
        },
        {
          id: "4",
          kind: "segment",
          segment: {
            segmentId: "seg-4",
            sourceHash: "seg-4-hash",
          },
        },
      ],
    };
    const segmentIndex = new Map(
      [
        createSegment("seg-1", "h2", "Install"),
        createSegment("seg-2", "p", "A".repeat(40)),
        createSegment("seg-3", "p", "B".repeat(40)),
        createSegment("seg-4", "p", "C".repeat(40)),
      ].map((segment) => [segment.segmentId, segment]),
    );

    const plan = planPageChunks({
      task,
      mapping,
      segmentIndex,
      chunking: createChunkingConfig(),
    });

    expect(plan.chunks).toHaveLength(2);
    expect(
      plan.chunks.map((chunk) => [chunk.itemStart, chunk.itemEnd]),
    ).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(plan.chunks.map((chunk) => chunk.headingText)).toEqual([
      "Install",
      "Install",
    ]);
  });
});
