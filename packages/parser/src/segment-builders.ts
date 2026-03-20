import type { SegmentRecord } from "@documirror/shared";
import {
  createSegmentId,
  createSegmentReuseKey,
  hashString,
  normalizeText,
} from "@documirror/shared";

export function createTextSegment(
  pageUrl: string,
  domPath: string,
  parentTag: string,
  pageTitle: string,
  sourceText: string,
): SegmentRecord | null {
  const normalizedText = normalizeText(sourceText);
  if (!normalizedText) {
    return null;
  }

  return {
    segmentId: createSegmentId(pageUrl, domPath, "text"),
    reuseKey: createSegmentReuseKey({
      pageUrl,
      kind: "text",
      normalizedText,
      tagName: parentTag,
      pageTitle,
    }),
    pageUrl,
    domPath,
    kind: "text",
    sourceText,
    normalizedText,
    sourceHash: hashString(normalizedText),
    context: {
      tagName: parentTag,
      pageTitle,
    },
  };
}

export function createAttributeSegment(
  pageUrl: string,
  domPath: string,
  tagName: string,
  pageTitle: string,
  attributeName: string,
  sourceText: string,
): SegmentRecord | null {
  const normalizedText = normalizeText(sourceText);
  if (!normalizedText) {
    return null;
  }

  return {
    segmentId: createSegmentId(pageUrl, domPath, "attr", attributeName),
    reuseKey: createSegmentReuseKey({
      pageUrl,
      kind: "attr",
      attributeName,
      normalizedText,
      tagName,
      pageTitle,
    }),
    pageUrl,
    domPath,
    kind: "attr",
    attributeName,
    sourceText,
    normalizedText,
    sourceHash: hashString(`${attributeName}:${normalizedText}`),
    context: {
      tagName,
      pageTitle,
    },
  };
}

export function createMetaSegment(
  pageUrl: string,
  domPath: string,
  tagName: string,
  pageTitle: string,
  sourceText: string,
): SegmentRecord | null {
  const normalizedText = normalizeText(sourceText);
  if (!normalizedText) {
    return null;
  }

  return {
    segmentId: createSegmentId(pageUrl, domPath, "meta", "content"),
    reuseKey: createSegmentReuseKey({
      pageUrl,
      kind: "meta",
      attributeName: "content",
      normalizedText,
      tagName,
      pageTitle,
    }),
    pageUrl,
    domPath,
    kind: "meta",
    attributeName: "content",
    sourceText,
    normalizedText,
    sourceHash: hashString(`content:${normalizedText}`),
    context: {
      tagName,
      pageTitle,
    },
  };
}
