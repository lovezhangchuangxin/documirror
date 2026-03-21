import { ZodError } from "zod";

import type {
  SegmentRecord,
  TranslationDraftResultFile,
  TranslationResultFile,
  TranslationTaskFile,
  TranslationTaskMappingFile,
  TranslationVerificationIssue,
} from "@documirror/shared";
import {
  extractPlaceholderTokens,
  normalizeText,
  parseInlineCodeSpans,
  replacePlaceholderTokens,
} from "@documirror/shared";

import type { CandidateVerification } from "../internal-types";
import {
  buildInlineGroupPlan,
  createInlineCodeMismatchMessage,
} from "./inline-groups";

export function verifyCandidateResult(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  segmentIndex: Map<string, SegmentRecord>,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): CandidateVerification {
  const errors = [
    ...validateTaskStructure(task),
    ...validateTaskFreshness(task, mapping, segmentIndex),
    ...validateTranslationsAgainstTask(task, mapping, result),
  ];
  const warnings = collectTranslationWarnings(task, result);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}

export function validateTaskStructure(
  task: TranslationTaskFile,
): TranslationVerificationIssue[] {
  const expectedIds = task.content.map((item) => item.id);
  return validateOrderedIds({
    actualIds: task.content.map((item) => item.id),
    expectedIds,
    collectionPath: "$.content",
    elementPath: "$.content",
    itemLabel: "task content id",
  });
}

export function validateTaskFreshness(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  segmentIndex: Map<string, SegmentRecord>,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];
  const taskContentIndex = new Map(
    task.content.map((item, index) => [item.id, index]),
  );

  mapping.items.forEach((item, index) => {
    const contentIndex = taskContentIndex.get(item.id) ?? index;
    const segmentRefs =
      item.kind === "segment" ? [item.segment] : item.segments;

    segmentRefs.forEach((segmentRef) => {
      const currentSegment = segmentIndex.get(segmentRef.segmentId);
      if (!currentSegment) {
        issues.push({
          code: "task_segment_missing",
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} no longer exists; rerun translate plan`,
          jsonPath: `$.content[${contentIndex}]`,
        });
        return;
      }

      if (currentSegment.sourceHash !== segmentRef.sourceHash) {
        issues.push({
          code: "task_stale",
          message: `Task ${task.taskId} is stale because segment ${segmentRef.segmentId} changed; rerun translate plan`,
          jsonPath: `$.content[${contentIndex}]`,
        });
      }
    });
  });

  return dedupeIssues(issues);
}

export function validateTranslationsAgainstTask(
  task: TranslationTaskFile,
  mapping: TranslationTaskMappingFile,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];
  const expectedIds = task.content.map((item) => item.id);
  const taskContentIndex = new Map(task.content.map((item) => [item.id, item]));

  if (mapping.items.length !== task.content.length) {
    issues.push({
      code: "mapping_item_count_mismatch",
      message: `Task mapping item count ${mapping.items.length} does not match task content count ${task.content.length}`,
      jsonPath: "$.content",
    });
  }

  if (result.taskId !== task.taskId) {
    issues.push({
      code: "task_id_mismatch",
      message: `Expected taskId "${task.taskId}" but got "${result.taskId}"`,
      jsonPath: "$.taskId",
    });
  }

  issues.push(
    ...validateOrderedIds({
      actualIds: result.translations.map((item) => item.id),
      expectedIds,
      collectionPath: "$.translations",
      elementPath: "$.translations",
      itemLabel: "translation id",
    }),
  );

  if (result.translations.length !== task.content.length) {
    issues.push({
      code: "translation_count_mismatch",
      message: `Expected ${task.content.length} translations but found ${result.translations.length}; make translations length match task.content exactly`,
      jsonPath: "$.translations",
    });
  }

  const mappingIndex = new Map(mapping.items.map((item) => [item.id, item]));

  result.translations.forEach((item, index) => {
    const taskItem = taskContentIndex.get(item.id);

    if (item.translatedText.trim().length === 0) {
      issues.push({
        code: "translation_empty",
        message: `Translation for id "${item.id}" is empty; fill translatedText with the completed translation`,
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }

    const mappedItem = mappingIndex.get(item.id);
    if (!mappedItem) {
      issues.push({
        code: "translation_id_unknown",
        message: `Translation id "${item.id}" is not present in the task mapping`,
        jsonPath: `$.translations[${index}].id`,
      });
      return;
    }

    if (taskItem) {
      issues.push(
        ...validateListMarkerPrefix(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validateLightweightMarkupStructure(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validatePlaceholderTokens(
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
      issues.push(
        ...validateGlossaryTargets(
          task.glossary,
          taskItem.text,
          item.translatedText,
          `$.translations[${index}].translatedText`,
        ),
      );
    }

    if (mappedItem.kind === "segment") {
      return;
    }

    const inlineGroupPlan = buildInlineGroupPlan(
      mappedItem,
      item.translatedText,
    );
    if (!inlineGroupPlan.ok) {
      const expectedInlineCodeSpans = mappedItem.inlineCodeSpans.map(
        (inlineCodeSpan) => inlineCodeSpan.text,
      );
      issues.push({
        code: "inline_code_mismatch",
        message: createInlineCodeMismatchMessage(
          item.id,
          expectedInlineCodeSpans,
          inlineGroupPlan,
        ),
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }
  });

  return dedupeIssues(issues);
}

export function collectTranslationWarnings(
  task: TranslationTaskFile,
  result:
    | TranslationDraftResultFile
    | Pick<TranslationResultFile, "taskId" | "translations">,
): TranslationVerificationIssue[] {
  const warnings: TranslationVerificationIssue[] = [];
  const taskContentIndex = new Map(task.content.map((item) => [item.id, item]));

  result.translations.forEach((item, index) => {
    const taskItem = taskContentIndex.get(item.id);
    if (!taskItem) {
      return;
    }

    if (looksUntranslated(taskItem.text, item.translatedText)) {
      warnings.push({
        code: "translation_suspiciously_identical",
        message: `Translation for id "${item.id}" is effectively identical to the source text; confirm that the text really should stay untranslated`,
        jsonPath: `$.translations[${index}].translatedText`,
      });
    }
  });

  return dedupeIssues(warnings);
}

export function dedupeIssues(
  issues: TranslationVerificationIssue[],
): TranslationVerificationIssue[] {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.code}::${issue.jsonPath}::${issue.message}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function validateOrderedIds(options: {
  actualIds: string[];
  expectedIds: string[];
  collectionPath: string;
  elementPath: string;
  itemLabel: string;
}): TranslationVerificationIssue[] {
  const { actualIds, expectedIds, collectionPath, elementPath, itemLabel } =
    options;
  const issues: TranslationVerificationIssue[] = [];
  const expectedIdSet = new Set(expectedIds);
  const seenIds = new Set<string>();

  actualIds.forEach((id, index) => {
    const expectedId = expectedIds[index];
    if (expectedId !== undefined && id !== expectedId) {
      issues.push({
        code: "id_out_of_order",
        message: `Expected ${itemLabel} "${expectedId}" at position ${
          index + 1
        } but found "${id}"; renumber items to match the task ids in order`,
        jsonPath: `${elementPath}[${index}].id`,
      });
    }

    if (seenIds.has(id)) {
      issues.push({
        code: "id_duplicate",
        message: `Duplicate ${itemLabel} "${id}" found; each id must appear exactly once`,
        jsonPath: `${elementPath}[${index}].id`,
      });
    }
    seenIds.add(id);
  });

  const missingIds = expectedIds.filter((id) => !actualIds.includes(id));
  if (missingIds.length > 0) {
    issues.push({
      code: "id_missing",
      message: `Missing ${itemLabel}${missingIds.length > 1 ? "s" : ""} ${missingIds
        .map((id) => `"${id}"`)
        .join(
          ", ",
        )}; add the missing items so ids exactly match the task ids in order`,
      jsonPath: collectionPath,
    });
  }

  const extraIds = actualIds.filter((id) => !expectedIdSet.has(id));
  if (extraIds.length > 0) {
    issues.push({
      code: "id_unknown",
      message: `Unexpected ${itemLabel}${extraIds.length > 1 ? "s" : ""} ${extraIds
        .map((id) => `"${id}"`)
        .join(", ")}; remove ids that are not present in the task`,
      jsonPath: collectionPath,
    });
  }

  return issues;
}

export function createIssuesFromUnknownError(
  error: unknown,
  rootPath: string,
): TranslationVerificationIssue[] {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      jsonPath: toJsonPath(
        rootPath,
        issue.path.filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        ),
      ),
    }));
  }

  if (error instanceof Error && error.name === "SyntaxError") {
    return [
      {
        code: "json_invalid",
        message: `Result file is not valid JSON: ${error.message}`,
        jsonPath: rootPath,
      },
    ];
  }

  return [
    {
      code: "unknown_error",
      message: String(error),
      jsonPath: rootPath,
    },
  ];
}

function validatePlaceholderTokens(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceTokens = extractPlaceholderTokens(sourceText);
  if (sourceTokens.length === 0) {
    return [];
  }

  const translatedTokens = extractPlaceholderTokens(translatedText);
  if (areStringMultisetsEqual(sourceTokens, translatedTokens)) {
    return [];
  }

  return [
    {
      code: "placeholder_mismatch",
      message: `Translation must preserve placeholders ${JSON.stringify(sourceTokens)} exactly`,
      jsonPath,
    },
  ];
}

function validateListMarkerPrefix(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceMarker = extractListMarkerPrefix(sourceText);
  if (!sourceMarker) {
    return [];
  }

  const translatedMarker = extractListMarkerPrefix(translatedText);
  if (translatedMarker === sourceMarker) {
    return [];
  }

  return [
    {
      code: "list_marker_mismatch",
      message: `Translation must preserve the leading list marker "${sourceMarker}"`,
      jsonPath,
    },
  ];
}

function validateLightweightMarkupStructure(
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const sourceSignature = getLightweightMarkupSignature(sourceText);
  const translatedSignature = getLightweightMarkupSignature(translatedText);
  const sourceEntries = Object.entries(sourceSignature).filter(
    ([, count]) => count > 0,
  );

  if (
    sourceEntries.every(
      ([key, count]) =>
        translatedSignature[key as keyof typeof translatedSignature] === count,
    )
  ) {
    return [];
  }

  const requiredFragments = sourceEntries
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  return [
    {
      code: "markup_structure_mismatch",
      message: `Translation must preserve lightweight markup structure (${requiredFragments})`,
      jsonPath,
    },
  ];
}

function validateGlossaryTargets(
  glossary: TranslationTaskFile["glossary"],
  sourceText: string,
  translatedText: string,
  jsonPath: string,
): TranslationVerificationIssue[] {
  const issues: TranslationVerificationIssue[] = [];

  glossary.forEach((entry) => {
    const sourceTerm = entry.source.trim();
    const targetTerm = entry.target.trim();
    if (!sourceTerm || !targetTerm) {
      return;
    }

    if (!containsGlossaryTerm(sourceText, sourceTerm)) {
      return;
    }

    if (containsGlossaryTerm(translatedText, targetTerm)) {
      return;
    }

    issues.push({
      code: "glossary_target_missing",
      message: `Translation must include glossary target "${targetTerm}" when the source contains "${sourceTerm}"`,
      jsonPath,
    });
  });

  return issues;
}

function extractListMarkerPrefix(value: string): string | null {
  const match = value.match(/^\s*(?:[-*+]\s+\[(?: |x|X)\]|[-*+]|\d+\.)\s+/u);
  return match?.[0] ?? null;
}

function getLightweightMarkupSignature(value: string): Record<string, number> {
  const comparableText = stripInlineCodeText(value);

  return {
    boldAsterisk: countMatches(comparableText, /\*\*[^*\n][\s\S]*?\*\*/gu),
    boldUnderscore: countMatches(comparableText, /__[^_\n][\s\S]*?__/gu),
    strike: countMatches(comparableText, /~~[^~\n][\s\S]*?~~/gu),
    image: countMatches(comparableText, /!\[[^\]]+\]\([^)]+\)/gu),
    link: countMatches(comparableText, /(?<!!)\[[^\]]+\]\([^)]+\)/gu),
  };
}

function areStringMultisetsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  const counts = new Map<string, number>();
  left.forEach((value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  });
  right.forEach((value) => {
    const next = (counts.get(value) ?? 0) - 1;
    counts.set(value, next);
  });

  return [...counts.values()].every((count) => count === 0);
}

function containsGlossaryTerm(text: string, term: string): boolean {
  const normalizedText = normalizeText(text);
  const normalizedTerm = normalizeText(term);
  if (!normalizedText || !normalizedTerm) {
    return false;
  }

  if (/^[A-Za-z0-9_-]+$/u.test(normalizedTerm)) {
    return new RegExp(`\\b${escapeRegExp(normalizedTerm)}\\b`, "iu").test(
      normalizedText,
    );
  }

  return normalizedText
    .toLocaleLowerCase()
    .includes(normalizedTerm.toLocaleLowerCase());
}

function looksUntranslated(
  sourceText: string,
  translatedText: string,
): boolean {
  const comparableSource = stripComparableText(sourceText);
  const comparableTranslation = stripComparableText(translatedText);

  return (
    comparableSource.length > 0 &&
    comparableSource === comparableTranslation &&
    /[\p{L}\p{N}]/u.test(comparableSource)
  );
}

function stripComparableText(value: string): string {
  return normalizeText(
    replacePlaceholderTokens(stripInlineCodeText(value), " "),
  )
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function stripInlineCodeText(value: string): string {
  const inlineCodeParsed = parseInlineCodeSpans(value);
  return inlineCodeParsed ? inlineCodeParsed.textSegments.join(" ") : value;
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function toJsonPath(rootPath: string, path: Array<string | number>): string {
  return path.reduce<string>((currentPath, segment) => {
    if (typeof segment === "number") {
      return `${currentPath}[${segment}]`;
    }

    return `${currentPath}.${segment}`;
  }, rootPath);
}
