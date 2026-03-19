import { load } from "cheerio";

import type {
  AssemblyMap,
  MirrorConfig,
  SegmentRecord,
} from "@documirror/shared";
import {
  assemblyMapSchema,
  createSegmentId,
  hashString,
  normalizeText,
} from "@documirror/shared";

type LooseNode = {
  type?: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: LooseNode[];
};

const SKIP_TAGS = new Set(["script", "style", "noscript", "pre", "code"]);

export type ExtractedPage = {
  segments: SegmentRecord[];
  assemblyMap: AssemblyMap;
};

export function extractSegmentsFromHtml(
  html: string,
  pageUrl: string,
  config: MirrorConfig,
): ExtractedPage {
  const $ = load(html);
  const pageTitle = normalizeText($("title").first().text());

  const roots =
    config.selectors.include.length > 0
      ? config.selectors.include.flatMap((selector) => $(selector).toArray())
      : [$("body").get(0) ?? $.root().get(0)];

  const segments: SegmentRecord[] = [];
  const bindings: AssemblyMap["bindings"] = [];
  const seen = new Set<string>();

  const pushSegment = (segment: SegmentRecord) => {
    if (seen.has(segment.segmentId)) {
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
      const sourceText = node.data ?? "";
      const normalizedText = normalizeText(sourceText);
      if (!normalizedText) {
        return;
      }

      const segmentId = createSegmentId(pageUrl, domPath, "text");
      pushSegment({
        segmentId,
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
      });
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

    const translateAttributes = config.attributeRules.translate.filter(
      (attributeName) => !config.attributeRules.ignore.includes(attributeName),
    );

    for (const attributeName of translateAttributes) {
      const sourceText = node.attribs?.[attributeName];
      if (!sourceText) {
        continue;
      }

      const normalizedText = normalizeText(sourceText);
      if (!normalizedText) {
        continue;
      }

      const segmentId = createSegmentId(
        pageUrl,
        domPath,
        "attr",
        attributeName,
      );
      pushSegment({
        segmentId,
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
      });
    }

    if (tagName === "meta") {
      const metaKey = node.attribs?.name ?? node.attribs?.property;
      const content = node.attribs?.content;
      if (
        metaKey &&
        content &&
        ["description", "og:title", "og:description", "twitter:title"].includes(
          metaKey,
        )
      ) {
        const normalizedText = normalizeText(content);
        if (normalizedText) {
          const segmentId = createSegmentId(
            pageUrl,
            domPath,
            "meta",
            "content",
          );
          pushSegment({
            segmentId,
            pageUrl,
            domPath,
            kind: "meta",
            attributeName: "content",
            sourceText: content,
            normalizedText,
            sourceHash: hashString(`content:${normalizedText}`),
            context: {
              tagName,
              pageTitle,
            },
          });
        }
      }
    }

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
