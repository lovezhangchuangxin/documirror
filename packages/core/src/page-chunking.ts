import type {
  MirrorAiChunkingConfig,
  SegmentRecord,
  TranslationDraftResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
} from "@documirror/shared";

export type PlannedPageChunk = {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  isWholeTask: boolean;
  headingText?: string;
  itemStart: number;
  itemEnd: number;
  content: TranslationTaskFile["content"];
  mappingItems: TranslationTaskMappingFile["items"];
  originalIds: string[];
};

export type PageChunkPlan = {
  taskId: string;
  pageUrl: string;
  chunks: PlannedPageChunk[];
};

type ChunkDescriptor = {
  index: number;
  sourceCharCount: number;
  headingLevel: number | null;
  headingText?: string;
};

type ItemSection = {
  headingText?: string;
  itemIndices: number[];
  itemSourceCharCounts: number[];
  sourceCharCount: number;
};

type ChunkRunArtifacts = {
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
  originalIds: string[];
};

export function planPageChunks(options: {
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
  segmentIndex: Map<string, SegmentRecord>;
  chunking: MirrorAiChunkingConfig;
}): PageChunkPlan {
  const { task, mapping, segmentIndex, chunking } = options;
  const descriptors = buildDescriptors(task, mapping, segmentIndex);
  const totalSourceCharCount = descriptors.reduce(
    (sum, descriptor) => sum + descriptor.sourceCharCount,
    0,
  );

  if (
    !chunking.enabled ||
    descriptors.length === 0 ||
    (descriptors.length <= chunking.maxItemsPerChunk &&
      totalSourceCharCount <= chunking.softMaxSourceCharsPerChunk)
  ) {
    return createWholeTaskPlan(task, mapping);
  }

  const sections = splitOversizedSections(
    buildSections(descriptors),
    chunking.maxItemsPerChunk,
    chunking.hardMaxSourceCharsPerChunk,
  );
  const chunkedSections = splitOversizedSections(
    mergeSectionsIntoChunks(
      sections,
      chunking.maxItemsPerChunk,
      chunking.softMaxSourceCharsPerChunk,
    ),
    chunking.maxItemsPerChunk,
    chunking.softMaxSourceCharsPerChunk,
  );

  if (chunkedSections.length <= 1) {
    return createWholeTaskPlan(task, mapping);
  }

  const chunks = chunkedSections.map((section, index) =>
    buildChunk({
      task,
      mapping,
      chunkIndex: index,
      chunkCount: chunkedSections.length,
      headingText: section.headingText,
      itemIndices: section.itemIndices,
    }),
  );

  return {
    taskId: task.taskId,
    pageUrl: task.page.url,
    chunks,
  };
}

export function createChunkTaskArtifacts(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  chunk: PlannedPageChunk,
): ChunkRunArtifacts {
  if (chunk.isWholeTask) {
    return {
      task,
      mapping,
      originalIds: chunk.originalIds,
    };
  }

  const createdAt = task.createdAt;
  const content = chunk.content.map((item, index) => ({
    ...item,
    id: String(index + 1),
  }));
  const mappingItems = chunk.mappingItems.map((item, index) => ({
    ...item,
    id: String(index + 1),
  }));

  return {
    task: {
      ...task,
      taskId: chunk.chunkId,
      createdAt,
      content,
    },
    mapping: {
      ...mapping,
      taskId: chunk.chunkId,
      createdAt,
      items: mappingItems,
    },
    originalIds: chunk.originalIds,
  };
}

export function mergeChunkDrafts(options: {
  taskId: string;
  chunkDrafts: Array<{
    chunk: PlannedPageChunk;
    draft: TranslationDraftResultFile;
    originalIds: string[];
  }>;
}): TranslationDraftResultFile {
  const translations = options.chunkDrafts.flatMap(
    ({ draft, originalIds }, chunkIndex) =>
      draft.translations.map((item, index) => {
        const originalId = originalIds[index];
        if (!originalId) {
          throw new Error(
            `Chunk ${chunkIndex + 1} produced more translations than expected`,
          );
        }

        return {
          id: originalId,
          translatedText: item.translatedText,
        };
      }),
  );

  return {
    schemaVersion: 2,
    taskId: options.taskId,
    translations,
  };
}

function createWholeTaskPlan(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
): PageChunkPlan {
  return {
    taskId: task.taskId,
    pageUrl: task.page.url,
    chunks: [
      {
        chunkId: task.taskId,
        chunkIndex: 0,
        chunkCount: 1,
        isWholeTask: true,
        itemStart: 1,
        itemEnd: task.content.length,
        content: task.content,
        mappingItems: mapping.items,
        originalIds: task.content.map((item) => item.id),
      },
    ],
  };
}

function buildDescriptors(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  segmentIndex: Map<string, SegmentRecord>,
): ChunkDescriptor[] {
  return task.content.map((item, index) => {
    const mappedItem = mapping.items[index];
    const segmentRef =
      mappedItem?.kind === "segment"
        ? mappedItem.segment
        : mappedItem?.segments[0];
    const segment = segmentRef
      ? segmentIndex.get(segmentRef.segmentId)
      : undefined;
    const headingLevel = extractHeadingLevel(segment?.context.tagName);
    const normalizedText = item.text.trim();

    return {
      index,
      sourceCharCount: normalizedText.length,
      headingLevel,
      headingText: headingLevel === null ? undefined : normalizedText,
    };
  });
}

function buildSections(descriptors: ChunkDescriptor[]): ItemSection[] {
  const sections: ItemSection[] = [];
  let current: ItemSection | null = null;

  descriptors.forEach((descriptor) => {
    if (descriptor.headingLevel !== null) {
      if (current && current.itemIndices.length > 0) {
        sections.push(current);
      }
      current = {
        headingText: descriptor.headingText,
        itemIndices: [descriptor.index],
        itemSourceCharCounts: [descriptor.sourceCharCount],
        sourceCharCount: descriptor.sourceCharCount,
      };
      return;
    }

    if (!current) {
      current = {
        itemIndices: [],
        itemSourceCharCounts: [],
        sourceCharCount: 0,
      };
    }

    current.itemIndices.push(descriptor.index);
    current.itemSourceCharCounts.push(descriptor.sourceCharCount);
    current.sourceCharCount += descriptor.sourceCharCount;
  });

  const finalSection: ItemSection | null = current;
  if (finalSection !== null) {
    sections.push(finalSection);
  }

  return sections;
}

function splitOversizedSections(
  sections: ItemSection[],
  maxItemsPerChunk: number,
  hardMaxSourceCharsPerChunk: number,
): ItemSection[] {
  return sections.flatMap((section) =>
    splitSectionByHardLimit(
      section,
      maxItemsPerChunk,
      hardMaxSourceCharsPerChunk,
    ),
  );
}

function splitSectionByHardLimit(
  section: ItemSection,
  maxItemsPerChunk: number,
  hardMaxSourceCharsPerChunk: number,
): ItemSection[] {
  if (
    section.itemIndices.length <= maxItemsPerChunk &&
    section.sourceCharCount <= hardMaxSourceCharsPerChunk
  ) {
    return [section];
  }

  const chunks: ItemSection[] = [];
  let currentIndices: number[] = [];
  let currentItemSourceCharCounts: number[] = [];
  let currentSourceCharCount = 0;

  section.itemIndices.forEach((itemIndex, itemPosition) => {
    const itemSourceCharCount = section.itemSourceCharCounts[itemPosition] ?? 0;
    const nextSourceCharCount = currentSourceCharCount + itemSourceCharCount;
    const nextItemCount = currentIndices.length + 1;
    if (
      currentIndices.length > 0 &&
      (nextItemCount > maxItemsPerChunk ||
        nextSourceCharCount > hardMaxSourceCharsPerChunk)
    ) {
      chunks.push({
        headingText: section.headingText,
        itemIndices: currentIndices,
        itemSourceCharCounts: currentItemSourceCharCounts,
        sourceCharCount: currentSourceCharCount,
      });
      currentIndices = [];
      currentItemSourceCharCounts = [];
      currentSourceCharCount = 0;
    }

    currentIndices.push(itemIndex);
    currentItemSourceCharCounts.push(itemSourceCharCount);
    currentSourceCharCount += itemSourceCharCount;
  });

  if (currentIndices.length > 0) {
    chunks.push({
      headingText: section.headingText,
      itemIndices: currentIndices,
      itemSourceCharCounts: currentItemSourceCharCounts,
      sourceCharCount: currentSourceCharCount,
    });
  }

  return chunks;
}

function mergeSectionsIntoChunks(
  sections: ItemSection[],
  maxItemsPerChunk: number,
  softMaxSourceCharsPerChunk: number,
): ItemSection[] {
  const chunks: ItemSection[] = [];
  let current: ItemSection | null = null;
  const minItemsForBoundary = Math.max(20, Math.floor(maxItemsPerChunk / 2));
  const minCharsForBoundary = Math.max(
    1_500,
    Math.floor(softMaxSourceCharsPerChunk / 2),
  );

  sections.forEach((section) => {
    if (!current) {
      current = cloneSection(section);
      return;
    }

    const wouldExceedSoftLimits =
      current.itemIndices.length + section.itemIndices.length >
        maxItemsPerChunk ||
      current.sourceCharCount + section.sourceCharCount >
        softMaxSourceCharsPerChunk;
    const shouldKeepHeadingBoundary =
      Boolean(section.headingText) &&
      current.itemIndices.length >= minItemsForBoundary &&
      current.sourceCharCount >= minCharsForBoundary;

    if (wouldExceedSoftLimits || shouldKeepHeadingBoundary) {
      chunks.push(current);
      current = cloneSection(section);
      return;
    }

    current.itemIndices.push(...section.itemIndices);
    current.itemSourceCharCounts.push(...section.itemSourceCharCounts);
    current.sourceCharCount += section.sourceCharCount;
    current.headingText ??= section.headingText;
  });

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function buildChunk(options: {
  task: TranslationTaskFile;
  mapping: TranslationTaskMappingFile;
  chunkIndex: number;
  chunkCount: number;
  headingText?: string;
  itemIndices: number[];
}): PlannedPageChunk {
  const { task, mapping, chunkIndex, chunkCount, headingText, itemIndices } =
    options;
  const startIndex = itemIndices[0] ?? 0;
  const endIndex = itemIndices[itemIndices.length - 1] ?? startIndex;
  const content = task.content.slice(startIndex, endIndex + 1);
  const mappingItems = mapping.items.slice(startIndex, endIndex + 1);

  return {
    chunkId: `${task.taskId}__chunk_${chunkIndex + 1}`,
    chunkIndex,
    chunkCount,
    isWholeTask: false,
    headingText,
    itemStart: startIndex + 1,
    itemEnd: endIndex + 1,
    content,
    mappingItems,
    originalIds: content.map((item) => item.id),
  };
}

function cloneSection(section: ItemSection): ItemSection {
  return {
    headingText: section.headingText,
    itemIndices: [...section.itemIndices],
    itemSourceCharCounts: [...section.itemSourceCharCounts],
    sourceCharCount: section.sourceCharCount,
  };
}

function extractHeadingLevel(tagName: string | undefined): number | null {
  const match = tagName?.toLowerCase().match(/^h([1-6])$/u);
  return match ? Number(match[1]) : null;
}
