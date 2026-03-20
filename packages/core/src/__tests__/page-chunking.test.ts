import { describe, expect, it } from "vitest";

import type {
  MirrorAiChunkingConfig,
  SegmentRecord,
  TranslationTaskFile,
  TranslationTaskMappingFile,
} from "@documirror/shared";

import { createChunkTaskArtifacts, planPageChunks } from "../page-chunking";

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

  it("preserves original ids in runtime chunk tasks", () => {
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
        { id: "41", text: "Install" },
        { id: "42", text: "Install the package" },
        { id: "43", text: "Run the setup" },
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
          id: "41",
          kind: "segment",
          segment: {
            segmentId: "seg-41",
            sourceHash: "seg-41-hash",
          },
        },
        {
          id: "42",
          kind: "segment",
          segment: {
            segmentId: "seg-42",
            sourceHash: "seg-42-hash",
          },
        },
        {
          id: "43",
          kind: "segment",
          segment: {
            segmentId: "seg-43",
            sourceHash: "seg-43-hash",
          },
        },
      ],
    };

    const artifacts = createChunkTaskArtifacts(task, mapping, {
      chunkId: "task_page__chunk_1",
      chunkIndex: 0,
      chunkCount: 2,
      isWholeTask: false,
      itemStart: 41,
      itemEnd: 43,
      content: task.content,
      mappingItems: mapping.items,
      originalIds: ["41", "42", "43"],
    });

    expect(artifacts.task.taskId).toBe("task_page__chunk_1");
    expect(artifacts.task.content.map((item) => item.id)).toEqual([
      "41",
      "42",
      "43",
    ]);
    expect(artifacts.mapping.items.map((item) => item.id)).toEqual([
      "41",
      "42",
      "43",
    ]);
  });
});
