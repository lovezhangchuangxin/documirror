import { load } from "cheerio";

import type {
  AssemblyMap,
  MirrorConfig,
  SegmentRecord,
} from "@documirror/shared";
import {
  assemblyMapSchema,
  collapseNestedDomRoots,
  normalizeText,
} from "@documirror/shared";

import { SKIP_TAGS, TRANSLATABLE_META_KEYS } from "./constants";
import {
  createAttributeSegment,
  createMetaSegment,
  createTextSegment,
} from "./segment-builders";
import type { ExtractedPage, LooseNode } from "./types";

export function extractSegmentsFromHtml(
  html: string,
  pageUrl: string,
  config: MirrorConfig,
): ExtractedPage {
  const $ = load(html);
  const pageTitle = normalizeText($("title").first().text());
  const roots = getExtractionRoots($, config);
  const segments: SegmentRecord[] = [];
  const bindings: AssemblyMap["bindings"] = [];
  const seen = new Set<string>();

  const pushSegment = (segment: SegmentRecord | null) => {
    if (!segment || seen.has(segment.segmentId)) {
      return;
    }

    seen.add(segment.segmentId);
    segments.push(segment);
    bindings.push({
      segmentId: segment.segmentId,
      domPath: segment.domPath,
      kind: segment.kind,
      attributeName: segment.attributeName,
    });
  };

  const visit = (
    node: LooseNode | undefined,
    domPath: string,
    parentTag: string,
  ) => {
    if (!node) {
      return;
    }

    if (node.type === "text") {
      pushSegment(
        createTextSegment(
          pageUrl,
          domPath,
          parentTag,
          pageTitle,
          node.data ?? "",
        ),
      );
      return;
    }

    if (
      node.type !== "tag" &&
      node.type !== "script" &&
      node.type !== "style"
    ) {
      return;
    }

    const tagName = node.name?.toLowerCase() ?? parentTag;
    if (SKIP_TAGS.has(tagName)) {
      return;
    }

    if (
      config.selectors.exclude.some((selector) => $(node as never).is(selector))
    ) {
      return;
    }

    for (const attributeName of getTranslatableAttributes(config)) {
      const sourceText = node.attribs?.[attributeName];
      if (!sourceText) {
        continue;
      }

      pushSegment(
        createAttributeSegment(
          pageUrl,
          domPath,
          tagName,
          pageTitle,
          attributeName,
          sourceText,
        ),
      );
    }

    const metaKey = node.attribs?.name ?? node.attribs?.property;
    if (tagName === "meta" && metaKey && TRANSLATABLE_META_KEYS.has(metaKey)) {
      pushSegment(
        createMetaSegment(
          pageUrl,
          domPath,
          tagName,
          pageTitle,
          node.attribs?.content ?? "",
        ),
      );
    }

    // Keep DOM-path traversal centralized so extraction and assembly stay aligned.
    node.children?.forEach((child, index) => {
      const childTag =
        child.type === "text" ? "#text" : (child.name?.toLowerCase() ?? "node");
      visit(child, `${domPath}/${childTag}[${index}]`, tagName);
    });
  };

  roots.forEach((root, index) => {
    visit(root as unknown as LooseNode, `root[${index}]`, "root");
  });

  return {
    segments,
    assemblyMap: assemblyMapSchema.parse({
      pageUrl,
      bindings,
    }),
  };
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

function getTranslatableAttributes(config: MirrorConfig): string[] {
  return config.attributeRules.translate.filter(
    (attributeName) => !config.attributeRules.ignore.includes(attributeName),
  );
}
