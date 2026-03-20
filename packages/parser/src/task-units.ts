import { load } from "cheerio";

import type { MirrorConfig, SegmentRecord } from "@documirror/shared";
import { collapseNestedDomRoots } from "@documirror/shared";

import { SKIP_TAGS } from "./constants";
import type { LooseNode } from "./types";

export type TranslationTaskUnitInlineCodeSpan = {
  text: string;
  domPath: string;
};

export type TranslationTaskUnit = {
  segments: SegmentRecord[];
  text: string;
  note?: string;
  inlineCodeSpans: TranslationTaskUnitInlineCodeSpan[];
  textSlotIndices: number[];
};

type ChildDescriptor =
  | {
      kind: "segment";
      segment: SegmentRecord;
    }
  | {
      kind: "code";
      text: string;
      domPath: string;
    }
  | {
      kind: "other";
    };

export function buildTranslationTaskUnits(
  html: string,
  pageUrl: string,
  config: MirrorConfig,
  segments: SegmentRecord[],
): TranslationTaskUnit[] {
  if (segments.some((segment) => segment.pageUrl !== pageUrl)) {
    throw new Error("All task-unit segments must belong to the same page");
  }

  const $ = load(html);
  const pendingTextSegmentsByDomPath = new Map(
    segments
      .filter((segment) => segment.kind === "text")
      .map((segment) => [segment.domPath, segment]),
  );
  const groupedUnitsByStartId = new Map<string, TranslationTaskUnit>();
  const groupedSegmentIds = new Set<string>();

  const visit = (node: LooseNode | undefined, domPath: string): void => {
    if (!node) {
      return;
    }

    if (
      node.type !== "tag" &&
      node.type !== "script" &&
      node.type !== "style"
    ) {
      return;
    }

    const tagName = node.name?.toLowerCase() ?? "root";
    if (SKIP_TAGS.has(tagName)) {
      return;
    }

    if (
      config.selectors.exclude.some((selector) => $(node as never).is(selector))
    ) {
      return;
    }

    const groupedUnits = collectGroupedUnits(
      $,
      node.children ?? [],
      domPath,
      pendingTextSegmentsByDomPath,
    );

    groupedUnits.forEach((unit) => {
      groupedUnitsByStartId.set(unit.segments[0].segmentId, unit);
      unit.segments.slice(1).forEach((segment) => {
        groupedSegmentIds.add(segment.segmentId);
      });
    });

    node.children?.forEach((child, index) => {
      const childTag =
        child.type === "text" ? "#text" : (child.name?.toLowerCase() ?? "node");
      visit(child, `${domPath}/${childTag}[${index}]`);
    });
  };

  getExtractionRoots($, config).forEach((root, index) => {
    visit(root as LooseNode, `root[${index}]`);
  });

  return segments.flatMap((segment) => {
    if (groupedSegmentIds.has(segment.segmentId)) {
      return [];
    }

    const groupedUnit = groupedUnitsByStartId.get(segment.segmentId);
    if (groupedUnit) {
      return [groupedUnit];
    }

    return [
      {
        segments: [segment],
        text: segment.sourceText,
        inlineCodeSpans: [],
        textSlotIndices: [0],
      },
    ];
  });
}

function collectGroupedUnits(
  $: ReturnType<typeof load>,
  children: LooseNode[],
  parentDomPath: string,
  pendingTextSegmentsByDomPath: Map<string, SegmentRecord>,
): TranslationTaskUnit[] {
  const descriptors = children.map((child, index) =>
    describeChild(
      $,
      child,
      `${parentDomPath}/${child.type === "text" ? "#text" : (child.name?.toLowerCase() ?? "node")}[${index}]`,
      pendingTextSegmentsByDomPath,
    ),
  );
  const units: TranslationTaskUnit[] = [];
  let run: ChildDescriptor[] = [];

  const flushRun = () => {
    const unit = buildTaskUnitFromRun(run);
    if (unit) {
      units.push(unit);
    }
    run = [];
  };

  for (const descriptor of descriptors) {
    if (descriptor.kind === "other") {
      flushRun();
      continue;
    }

    if (
      descriptor.kind === "segment" &&
      run[run.length - 1]?.kind === "segment"
    ) {
      flushRun();
    }

    run.push(descriptor);
  }

  flushRun();
  return units;
}

function buildTaskUnitFromRun(
  run: ChildDescriptor[],
): TranslationTaskUnit | null {
  if (run.length === 0) {
    return null;
  }

  const segments: SegmentRecord[] = [];
  const inlineCodeSpans: TranslationTaskUnitInlineCodeSpan[] = [];
  const textSlotIndices: number[] = [];
  let textSlotIndex = 0;

  for (const descriptor of run) {
    if (descriptor.kind === "segment") {
      segments.push(descriptor.segment);
      textSlotIndices.push(textSlotIndex);
      continue;
    }

    if (descriptor.kind === "code") {
      inlineCodeSpans.push({
        text: descriptor.text,
        domPath: descriptor.domPath,
      });
      textSlotIndex += 1;
    }
  }

  if (segments.length === 0 || inlineCodeSpans.length === 0) {
    return null;
  }

  return {
    segments,
    text: assembleInlineCodeText(run),
    note: createInlineCodeNote(),
    inlineCodeSpans,
    textSlotIndices,
  };
}

function describeChild(
  $: ReturnType<typeof load>,
  child: LooseNode,
  domPath: string,
  pendingTextSegmentsByDomPath: Map<string, SegmentRecord>,
): ChildDescriptor {
  if (child.type === "text") {
    const segment = pendingTextSegmentsByDomPath.get(domPath);
    return segment ? { kind: "segment", segment } : { kind: "other" };
  }

  if (
    child.type !== "tag" &&
    child.type !== "script" &&
    child.type !== "style"
  ) {
    return { kind: "other" };
  }

  const tagName = child.name?.toLowerCase() ?? "node";
  if (tagName !== "code") {
    return { kind: "other" };
  }

  const text = $(child as never).text();
  return text ? { kind: "code", text, domPath } : { kind: "other" };
}

function assembleInlineCodeText(run: ChildDescriptor[]): string {
  let text = "";

  run.forEach((descriptor) => {
    if (descriptor.kind === "segment") {
      text += descriptor.segment.sourceText;
      return;
    }

    if (descriptor.kind === "code") {
      text += renderInlineCodeSpan(descriptor.text);
    }
  });

  return text;
}

function createInlineCodeNote(): string {
  return "Treat text wrapped in backticks as code literals. Keep each inline code span unchanged. You may reorder inline code and surrounding text when needed for natural target-language syntax, but keep every code span exactly once.";
}

function renderInlineCodeSpan(text: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(/`+/gu)].map((match) => match[0].length),
  );
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}${text}${fence}`;
}

function getExtractionRoots(
  $: ReturnType<typeof load>,
  config: MirrorConfig,
): unknown[] {
  if (config.selectors.include.length > 0) {
    return collapseNestedDomRoots(
      config.selectors.include.flatMap((selector) => $(selector).toArray()),
    );
  }

  return [$("body").get(0) ?? $.root().get(0)].filter(Boolean);
}
