import type { AssemblyMap, SegmentRecord } from "@documirror/shared";

export type LooseNode = {
  type?: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: LooseNode[];
};

export type ExtractedPage = {
  segments: SegmentRecord[];
  assemblyMap: AssemblyMap;
};
