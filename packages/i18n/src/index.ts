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
  const segmentById = new Map(
    segments.map((segment) => [segment.segmentId, segment]),
  );

  return translations.map((translation) => {
    const currentSegment = segmentById.get(translation.segmentId);
    if (
      currentSegment &&
      currentSegment.sourceHash === translation.sourceHash
    ) {
      return {
        ...translation,
        reuseKey: currentSegment.reuseKey ?? translation.reuseKey,
        status:
          translation.status === "stale" ? "accepted" : translation.status,
        updatedAt:
          translation.status === "stale"
            ? createTimestamp()
            : translation.updatedAt,
      };
    }

    return {
      ...translation,
      reuseKey: translation.reuseKey,
      status: "stale",
      updatedAt: createTimestamp(),
    };
  });
}

export function carryForwardTranslations(
  segments: SegmentRecord[],
  translations: TranslationRecord[],
): TranslationRecord[] {
  const translationIndex = buildTranslationIndex(translations);
  const clonedTranslations: TranslationRecord[] = [];
  const sourceCandidatesByKey = new Map<string, TranslationRecord[]>();
  const pendingSegmentsByKey = new Map<string, SegmentRecord[]>();

  translations.forEach((translation) => {
    if (!translation.reuseKey || translation.status === "draft") {
      return;
    }

    const key = `${translation.reuseKey}::${translation.sourceHash}`;
    const candidates = sourceCandidatesByKey.get(key) ?? [];
    candidates.push(translation);
    sourceCandidatesByKey.set(key, candidates);
  });

  segments.forEach((segment) => {
    if (!segment.reuseKey || translationIndex.has(segment.segmentId)) {
      return;
    }

    const key = `${segment.reuseKey}::${segment.sourceHash}`;
    const pendingSegments = pendingSegmentsByKey.get(key) ?? [];
    pendingSegments.push(segment);
    pendingSegmentsByKey.set(key, pendingSegments);
  });

  pendingSegmentsByKey.forEach((pendingSegments, key) => {
    const candidates = sourceCandidatesByKey.get(key) ?? [];
    if (pendingSegments.length !== 1 || candidates.length !== 1) {
      return;
    }

    const [segment] = pendingSegments;
    const [candidate] = candidates;
    if (!segment || !candidate) {
      return;
    }

    clonedTranslations.push({
      segmentId: segment.segmentId,
      reuseKey: segment.reuseKey,
      targetLocale: candidate.targetLocale,
      translatedText: candidate.translatedText,
      sourceHash: segment.sourceHash,
      status: "accepted",
      provider: candidate.provider,
      updatedAt: candidate.updatedAt,
    });
  });

  if (clonedTranslations.length === 0) {
    return translations;
  }

  return [...translations, ...clonedTranslations];
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
