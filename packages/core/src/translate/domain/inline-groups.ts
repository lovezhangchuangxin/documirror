import { parseInlineCodeSpans } from "@documirror/shared";
import type {
  TranslationInlineGroupPlan,
  TranslationTaskMappingEntry,
} from "@documirror/shared";

import type { InlineGroupPlanBuildResult } from "../internal-types";

export function buildInlineGroupPlan(
  mappedItem: Extract<TranslationTaskMappingEntry, { kind: "inline-code" }>,
  translatedText: string,
): InlineGroupPlanBuildResult {
  const parsed = parseInlineCodeSpans(translatedText);
  if (!parsed) {
    return {
      ok: false,
      reason:
        "current translation does not contain valid backtick-wrapped inline code spans",
      foundInlineCodeSpans: [],
    };
  }

  const matchedCodeParts = matchInlineCodeParts(
    mappedItem.inlineCodeSpans,
    parsed.inlineCodeSpans,
  );
  if (!matchedCodeParts) {
    return {
      ok: false,
      reason: `found ${JSON.stringify(parsed.inlineCodeSpans)}`,
      foundInlineCodeSpans: parsed.inlineCodeSpans,
    };
  }

  const parts: TranslationInlineGroupPlan["parts"] = [];

  parsed.textSegments.forEach((textSegment, index) => {
    if (textSegment.length > 0) {
      parts.push({
        kind: "text",
        translatedText: textSegment,
      });
    }

    const codePart = matchedCodeParts[index];
    if (codePart) {
      parts.push(codePart);
    }
  });

  return {
    ok: true,
    plan: {
      groupId: mappedItem.segments[0]?.segmentId ?? mappedItem.id,
      segmentIds: mappedItem.segments.map((segment) => segment.segmentId),
      parts,
    },
    projectedSegmentTexts: projectTranslatedTextParts(
      parsed.textSegments,
      mappedItem.segments.length,
    ),
    foundInlineCodeSpans: parsed.inlineCodeSpans,
  };
}

export function matchInlineCodeParts(
  expectedInlineCodeSpans: Array<{ text: string; domPath: string }>,
  translatedInlineCodeSpans: string[],
): Array<{ kind: "code"; text: string; domPath: string }> | null {
  const expectedQueues = new Map<
    string,
    Array<{ text: string; domPath: string }>
  >();

  expectedInlineCodeSpans.forEach((inlineCodeSpan) => {
    const queue = expectedQueues.get(inlineCodeSpan.text) ?? [];
    queue.push(inlineCodeSpan);
    expectedQueues.set(inlineCodeSpan.text, queue);
  });

  const matched: Array<{ kind: "code"; text: string; domPath: string }> = [];

  for (const inlineCodeSpan of translatedInlineCodeSpans) {
    const queue = expectedQueues.get(inlineCodeSpan);
    const matchedInlineCodeSpan = queue?.shift();
    if (!matchedInlineCodeSpan) {
      return null;
    }

    matched.push({
      kind: "code",
      text: matchedInlineCodeSpan.text,
      domPath: matchedInlineCodeSpan.domPath,
    });
  }

  if ([...expectedQueues.values()].some((queue) => queue.length > 0)) {
    return null;
  }

  return matched;
}

export function projectTranslatedTextParts(
  textSegments: string[],
  segmentCount: number,
): string[] {
  const projected = Array.from({ length: segmentCount }, () => "");
  if (segmentCount === 0) {
    return projected;
  }

  const visibleTextSegments = textSegments.filter((textSegment) => textSegment);
  visibleTextSegments.forEach((textSegment, index) => {
    const targetIndex = Math.min(index, segmentCount - 1);
    projected[targetIndex] = `${projected[targetIndex] ?? ""}${textSegment}`;
  });

  return projected;
}

export function createInlineCodeMismatchMessage(
  itemId: string,
  expectedInlineCodeSpans: string[],
  buildResult: Extract<InlineGroupPlanBuildResult, { ok: false }>,
): string {
  const baseMessage = `Translation for id "${itemId}" must preserve inline code spans ${JSON.stringify(expectedInlineCodeSpans)} exactly`;
  return `${baseMessage}; ${buildResult.reason}`;
}
