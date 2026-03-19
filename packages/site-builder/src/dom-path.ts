import type { CheerioAPI } from "cheerio";

import { collapseNestedDomRoots } from "@documirror/shared";
import type { MirrorConfig } from "@documirror/shared";

import type { LooseNode } from "./types";

export function locateNode(
  $: CheerioAPI,
  config: MirrorConfig,
  domPath: string,
): LooseNode | null {
  const roots = getAssemblyRoots($, config);
  const parts = domPath.split("/");
  const rootPart = parts.shift();
  if (!rootPart) {
    return null;
  }

  const rootMatch = rootPart.match(/^root\[(\d+)\]$/);
  if (!rootMatch) {
    return null;
  }

  let current = roots[Number(rootMatch[1])] as LooseNode | undefined;
  for (const part of parts) {
    const match = part.match(/^[^[]+\[(\d+)\]$/);
    if (!match || !current?.children) {
      return null;
    }

    current = current.children[Number(match[1])];
  }

  return current ?? null;
}

function getAssemblyRoots($: CheerioAPI, config: MirrorConfig): unknown[] {
  if (config.selectors.include.length > 0) {
    return collapseNestedDomRoots(
      config.selectors.include.flatMap((selector) => $(selector).toArray()),
    );
  }

  return [$("body").get(0) ?? $.root().get(0)].filter(Boolean);
}
