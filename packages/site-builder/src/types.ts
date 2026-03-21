import type {
  AssemblyMap,
  CommandProfile,
  Logger,
  Manifest,
  MirrorConfig,
  SegmentRecord,
  TranslationRecord,
} from "@documirror/shared";

export type LooseNode = {
  type?: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: LooseNode[];
  parent?: LooseNode | null;
  prev?: LooseNode | null;
  next?: LooseNode | null;
};

export type BuildSiteOptions = {
  repoDir: string;
  config: MirrorConfig;
  manifest: Manifest;
  segments: SegmentRecord[];
  assemblyMaps: AssemblyMap[];
  translations: TranslationRecord[];
  logger: Logger;
  profile?: boolean;
};

export type BuildSiteResult = {
  pageCount: number;
  assetCount: number;
  missingTranslations: number;
  profile?: CommandProfile;
};
