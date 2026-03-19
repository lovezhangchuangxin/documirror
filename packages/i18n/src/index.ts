import type { SegmentRecord, TranslationRecord } from "@documirror/shared";
import { DEFAULT_SEGMENTS_PER_TASK, createTimestamp } from "@documirror/shared";

export function buildTranslationIndex(
  records: TranslationRecord[],
): Map<string, TranslationRecord> {
  return new Map(records.map((record) => [record.segmentId, record]));
}

export function markStaleTranslations(
  segments: SegmentRecord[],
  translations: TranslationRecord[],
): TranslationRecord[] {
  const segmentHashById = new Map(
    segments.map((segment) => [segment.segmentId, segment.sourceHash]),
  );

  return translations.map((translation) => {
    const sourceHash = segmentHashById.get(translation.segmentId);
    if (!sourceHash || sourceHash === translation.sourceHash) {
      return translation;
    }

    return {
      ...translation,
      status: "stale",
      updatedAt: createTimestamp(),
    };
  });
}

export function findPendingSegments(
  segments: SegmentRecord[],
  translations: TranslationRecord[],
): SegmentRecord[] {
  const translationIndex = buildTranslationIndex(translations);

  return segments.filter((segment) => {
    const translation = translationIndex.get(segment.segmentId);
    if (!translation) {
      return true;
    }

    return (
      translation.sourceHash !== segment.sourceHash ||
      translation.status !== "accepted"
    );
  });
}

export function chunkSegments<T>(
  segments: T[],
  chunkSize = DEFAULT_SEGMENTS_PER_TASK,
): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < segments.length; index += chunkSize) {
    chunks.push(segments.slice(index, index + chunkSize));
  }
  return chunks;
}
