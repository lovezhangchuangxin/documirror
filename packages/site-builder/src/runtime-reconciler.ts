import type { CheerioAPI } from "cheerio";
import { join } from "pathe";

import type { BuildSiteOptions } from "./types";

export const RUNTIME_RECONCILER_ASSET_OUTPUT_PATH =
  "_documirror/runtime-reconciler.js";
export const RUNTIME_RECONCILER_DATA_SCRIPT_ID =
  "__DOCUMIRROR_RECONCILER_DATA__";
export const RUNTIME_RECONCILER_STATE_KEY = "__DOCUMIRROR_RECONCILER__";
export const RUNTIME_RECONCILER_ATTRIBUTE_NAMES = [
  "title",
  "alt",
  "aria-label",
  "placeholder",
] as const;

const RUNTIME_IGNORED_TAG_NAMES = new Set([
  "script",
  "style",
  "pre",
  "code",
  "noscript",
]);

export type RuntimeReconcilerAttributeName =
  (typeof RUNTIME_RECONCILER_ATTRIBUTE_NAMES)[number];

export type RuntimeReconcilerManifest = {
  version: 1;
  text: Record<string, string>;
  attributes: Record<RuntimeReconcilerAttributeName, Record<string, string>>;
};

type CollectRuntimeReconcilerManifestOptions = {
  pageUrl: string;
  config: BuildSiteOptions["config"];
  segments: BuildSiteOptions["segments"];
  translationIndex: Map<string, BuildSiteOptions["translations"][number]>;
};

type CollectRuntimeReconcilerManifestResult = {
  manifest: RuntimeReconcilerManifest;
  conflictCount: number;
};

export type RuntimeReconcileResult = {
  attributeHits: number;
  textHits: number;
};

export type RuntimeDomNodeLike = {
  childNodes?: ArrayLike<RuntimeDomNodeLike>;
  nodeType: number;
  parentNode?: RuntimeDomNodeLike | null;
  textContent?: string | null;
};

export type RuntimeDomElementLike = RuntimeDomNodeLike & {
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
  tagName?: string;
};

type RuntimeMutationObserverOptions = {
  attributeFilter: string[];
  attributes: boolean;
  characterData: boolean;
  childList: boolean;
  subtree: boolean;
};

type RuntimeMutationRecordLike = {
  addedNodes?: ArrayLike<RuntimeDomNodeLike>;
  target: RuntimeDomNodeLike & RuntimeDomElementLike;
  type: "attributes" | "characterData" | "childList" | string;
};

type RuntimeMutationObserverLike = {
  disconnect?: () => void;
  observe?: (
    target: RuntimeDomNodeLike,
    options: RuntimeMutationObserverOptions,
  ) => void;
};

type RuntimeDocumentLike = {
  body?: RuntimeDomElementLike | null;
  getElementById?: (id: string) => { textContent?: string | null } | null;
};

type RuntimeWindowLike = {
  MutationObserver?: new (
    callback: (records: RuntimeMutationRecordLike[]) => void,
  ) => RuntimeMutationObserverLike;
  addEventListener?: (
    eventName: string,
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
  document?: RuntimeDocumentLike | null;
  [key: string]: unknown;
};

type RuntimeObserverState = {
  isApplying?: boolean;
  manifest?: RuntimeReconcilerManifest;
  observeOptions?: RuntimeMutationObserverOptions;
  observeTarget?: RuntimeDomNodeLike | null;
  observer?: RuntimeMutationObserverLike | null;
  started?: boolean;
};

export function createEmptyRuntimeReconcilerManifest(): RuntimeReconcilerManifest {
  return {
    version: 1,
    text: {},
    attributes: {
      title: {},
      alt: {},
      "aria-label": {},
      placeholder: {},
    },
  };
}

export function hasRuntimeReconcilerEntries(
  manifest: RuntimeReconcilerManifest,
): boolean {
  if (Object.keys(manifest.text).length > 0) {
    return true;
  }

  return RUNTIME_RECONCILER_ATTRIBUTE_NAMES.some(
    (attributeName) =>
      Object.keys(manifest.attributes[attributeName]).length > 0,
  );
}

export function collectRuntimeReconcilerManifestForPage(
  options: CollectRuntimeReconcilerManifestOptions,
): CollectRuntimeReconcilerManifestResult {
  const { pageUrl, config, segments, translationIndex } = options;
  if (!config.build.runtimeReconciler.enabled) {
    return {
      manifest: createEmptyRuntimeReconcilerManifest(),
      conflictCount: 0,
    };
  }

  const manifest = createEmptyRuntimeReconcilerManifest();
  const textMap = new Map<string, string>();
  const textConflicts = new Set<string>();
  const attributeMaps = new Map<
    RuntimeReconcilerAttributeName,
    Map<string, string>
  >(
    RUNTIME_RECONCILER_ATTRIBUTE_NAMES.map((attributeName) => [
      attributeName,
      new Map<string, string>(),
    ]),
  );
  const attributeConflicts = new Map<
    RuntimeReconcilerAttributeName,
    Set<string>
  >(
    RUNTIME_RECONCILER_ATTRIBUTE_NAMES.map((attributeName) => [
      attributeName,
      new Set<string>(),
    ]),
  );

  for (const segment of segments) {
    if (segment.pageUrl !== pageUrl) {
      continue;
    }

    const translation = translationIndex.get(segment.segmentId);
    if (!translation || translation.sourceHash !== segment.sourceHash) {
      continue;
    }

    if (
      !isRuntimeReconcilerCandidate(
        segment.sourceText,
        translation.translatedText,
      ) ||
      isIgnoredRuntimeContext(segment.context.tagName)
    ) {
      continue;
    }

    if (segment.kind === "text") {
      registerRuntimeMapping(
        textMap,
        textConflicts,
        segment.sourceText,
        translation.translatedText,
      );
      continue;
    }

    if (segment.kind !== "attr") {
      continue;
    }

    const attributeName = normalizeRuntimeAttributeName(segment.attributeName);
    if (!attributeName) {
      continue;
    }

    registerRuntimeMapping(
      attributeMaps.get(attributeName) ?? new Map<string, string>(),
      attributeConflicts.get(attributeName) ?? new Set<string>(),
      segment.sourceText,
      translation.translatedText,
    );
  }

  textConflicts.forEach((sourceText) => {
    textMap.delete(sourceText);
  });

  RUNTIME_RECONCILER_ATTRIBUTE_NAMES.forEach((attributeName) => {
    const currentMap = attributeMaps.get(attributeName);
    const conflicts = attributeConflicts.get(attributeName);
    conflicts?.forEach((sourceText) => {
      currentMap?.delete(sourceText);
    });
  });

  manifest.text = Object.fromEntries(textMap);
  RUNTIME_RECONCILER_ATTRIBUTE_NAMES.forEach((attributeName) => {
    manifest.attributes[attributeName] = Object.fromEntries(
      attributeMaps.get(attributeName) ?? [],
    );
  });

  const conflictCount =
    textConflicts.size +
    [...attributeConflicts.values()].reduce(
      (total, conflicts) => total + conflicts.size,
      0,
    );

  return {
    manifest,
    conflictCount,
  };
}

export function createRuntimeReconcilerPublicAssetPath(
  basePath: string,
): string {
  return join(basePath || "/", RUNTIME_RECONCILER_ASSET_OUTPUT_PATH);
}

export function injectRuntimeReconcilerArtifacts(
  $: CheerioAPI,
  manifest: RuntimeReconcilerManifest,
  publicAssetPath: string,
): void {
  if (!hasRuntimeReconcilerEntries(manifest)) {
    return;
  }

  const dataScript = `<script type="application/json" id="${RUNTIME_RECONCILER_DATA_SCRIPT_ID}">${serializeRuntimeManifest(
    manifest,
  )}</script>`;
  const loaderScript = `<script src="${escapeHtmlAttribute(
    publicAssetPath,
  )}" data-documirror-runtime-reconciler="true"></script>`;
  const head = $("head").first();

  if (head.length > 0) {
    head.append(dataScript);
  } else {
    const body = $("body").first();
    if (body.length > 0) {
      body.prepend(dataScript);
    } else {
      $.root().append(dataScript);
    }
  }

  const body = $("body").first();
  if (body.length > 0) {
    body.append(loaderScript);
    return;
  }

  const html = $("html").first();
  if (html.length > 0) {
    html.append(loaderScript);
    return;
  }

  $.root().append(loaderScript);
}

export function reconcileRuntimeTextNode(
  node: RuntimeDomNodeLike,
  manifest: RuntimeReconcilerManifest,
): boolean {
  return documirrorReconcileTextNode(node, manifest);
}

export function reconcileRuntimeElementAttributes(
  element: RuntimeDomElementLike,
  manifest: RuntimeReconcilerManifest,
): number {
  return documirrorReconcileElementAttributes(element, manifest);
}

export function reconcileRuntimeSubtree(
  root: RuntimeDomNodeLike,
  manifest: RuntimeReconcilerManifest,
): RuntimeReconcileResult {
  return documirrorReconcileSubtree(root, manifest);
}

export function createRuntimeReconcilerAssetSource(): string {
  return [
    ...RUNTIME_ASSET_FUNCTIONS.map((fn) => fn.toString()),
    `(${documirrorRuntimeLoader.toString()})(window, "${RUNTIME_RECONCILER_STATE_KEY}", "${RUNTIME_RECONCILER_DATA_SCRIPT_ID}");`,
    "",
  ].join("\n");
}

function registerRuntimeMapping(
  mapping: Map<string, string>,
  conflicts: Set<string>,
  sourceText: string,
  translatedText: string,
): void {
  const existing = mapping.get(sourceText);
  if (!existing) {
    mapping.set(sourceText, translatedText);
    return;
  }

  if (existing !== translatedText) {
    conflicts.add(sourceText);
  }
}

function normalizeRuntimeAttributeName(
  attributeName: string | undefined,
): RuntimeReconcilerAttributeName | null {
  if (!attributeName) {
    return null;
  }

  const lowered = attributeName.toLowerCase();
  return RUNTIME_RECONCILER_ATTRIBUTE_NAMES.includes(
    lowered as RuntimeReconcilerAttributeName,
  )
    ? (lowered as RuntimeReconcilerAttributeName)
    : null;
}

function isRuntimeReconcilerCandidate(
  sourceText: string,
  translatedText: string,
): boolean {
  const trimmedSourceText = sourceText.trim();
  if (trimmedSourceText.length < 2) {
    return false;
  }

  if (!/[\p{L}]/u.test(trimmedSourceText)) {
    return false;
  }

  if (translatedText.trim().length === 0) {
    return false;
  }

  return sourceText !== translatedText;
}

function isIgnoredRuntimeContext(tagName: string | undefined): boolean {
  return Boolean(
    tagName && RUNTIME_IGNORED_TAG_NAMES.has(tagName.toLowerCase()),
  );
}

function serializeRuntimeManifest(manifest: RuntimeReconcilerManifest): string {
  return JSON.stringify(manifest)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026");
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;");
}

function documirrorRuntimeAttributeNames(): RuntimeReconcilerAttributeName[] {
  return ["title", "alt", "aria-label", "placeholder"];
}

function documirrorIgnoredTagNames(): string[] {
  return ["script", "style", "pre", "code", "noscript"];
}

function documirrorGetChildNodes(node: RuntimeDomNodeLike | null | undefined) {
  if (!node?.childNodes) {
    return [];
  }

  return Array.from(node.childNodes);
}

function documirrorHasIgnoredAncestor(
  node: RuntimeDomNodeLike | null | undefined,
): boolean {
  let current =
    node?.nodeType === 1
      ? (node as RuntimeDomElementLike)
      : ((node?.parentNode ?? null) as RuntimeDomElementLike | null);

  while (current) {
    if (
      current.nodeType === 1 &&
      typeof current.tagName === "string" &&
      documirrorIgnoredTagNames().includes(current.tagName.toLowerCase())
    ) {
      return true;
    }

    current = current.parentNode ?? null;
  }

  return false;
}

function documirrorReconcileTextNode(
  node: RuntimeDomNodeLike | null | undefined,
  manifest: RuntimeReconcilerManifest,
): boolean {
  if (!node || node.nodeType !== 3 || documirrorHasIgnoredAncestor(node)) {
    return false;
  }

  const currentValue = node.textContent ?? "";
  const translatedValue = manifest.text[currentValue];
  if (!translatedValue || translatedValue === currentValue) {
    return false;
  }

  node.textContent = translatedValue;
  return true;
}

function documirrorReconcileElementAttributes(
  element: RuntimeDomElementLike | null | undefined,
  manifest: RuntimeReconcilerManifest,
): number {
  if (
    !element ||
    element.nodeType !== 1 ||
    documirrorHasIgnoredAncestor(element) ||
    typeof element.getAttribute !== "function" ||
    typeof element.setAttribute !== "function"
  ) {
    return 0;
  }

  let hits = 0;

  for (const attributeName of documirrorRuntimeAttributeNames()) {
    const currentValue = element.getAttribute(attributeName);
    if (currentValue === null) {
      continue;
    }

    const translatedValue = manifest.attributes[attributeName][currentValue];
    if (!translatedValue || translatedValue === currentValue) {
      continue;
    }

    element.setAttribute(attributeName, translatedValue);
    hits += 1;
  }

  return hits;
}

function documirrorReconcileSubtree(
  root: RuntimeDomNodeLike | null | undefined,
  manifest: RuntimeReconcilerManifest,
): RuntimeReconcileResult {
  if (!root) {
    return {
      attributeHits: 0,
      textHits: 0,
    };
  }

  if (root.nodeType === 3) {
    return {
      attributeHits: 0,
      textHits: documirrorReconcileTextNode(root, manifest) ? 1 : 0,
    };
  }

  if (
    root.nodeType === 1 &&
    typeof (root as RuntimeDomElementLike).tagName === "string" &&
    documirrorIgnoredTagNames().includes(
      ((root as RuntimeDomElementLike).tagName ?? "").toLowerCase(),
    )
  ) {
    return {
      attributeHits: 0,
      textHits: 0,
    };
  }

  let attributeHits =
    root.nodeType === 1
      ? documirrorReconcileElementAttributes(root, manifest)
      : 0;
  let textHits = 0;

  for (const childNode of documirrorGetChildNodes(root)) {
    const childResult = documirrorReconcileSubtree(childNode, manifest);
    attributeHits += childResult.attributeHits;
    textHits += childResult.textHits;
  }

  return {
    attributeHits,
    textHits,
  };
}

function documirrorReadManifestFromDataScript(
  windowObject: RuntimeWindowLike | null | undefined,
  dataScriptId: string,
): RuntimeReconcilerManifest | null {
  const documentObject = windowObject?.document;
  if (!documentObject || typeof documentObject.getElementById !== "function") {
    return null;
  }

  const dataScript = documentObject.getElementById(dataScriptId);
  if (!dataScript || typeof dataScript.textContent !== "string") {
    return null;
  }

  try {
    return JSON.parse(dataScript.textContent) as RuntimeReconcilerManifest;
  } catch {
    return null;
  }
}

function documirrorRunWithObserverPaused(
  state: RuntimeObserverState | null | undefined,
  callback: () => void,
): void {
  if (!state || state.isApplying) {
    return;
  }

  const observer = state.observer;
  const observeTarget = state.observeTarget;
  const observeOptions = state.observeOptions;

  state.isApplying = true;
  observer?.disconnect?.();

  try {
    callback();
  } finally {
    state.isApplying = false;
    if (observer && observeTarget && observeOptions) {
      observer.observe?.(observeTarget, observeOptions);
    }
  }
}

function documirrorAttachObserver(
  windowObject: RuntimeWindowLike | null | undefined,
  state: RuntimeObserverState | null | undefined,
): void {
  if (
    !windowObject?.MutationObserver ||
    !windowObject.document?.body ||
    !state?.manifest
  ) {
    return;
  }

  const manifest = state.manifest;
  const observeOptions = {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...documirrorRuntimeAttributeNames()],
  };
  const observer = new windowObject.MutationObserver((records) => {
    if (state.isApplying) {
      return;
    }

    documirrorRunWithObserverPaused(state, () => {
      for (const record of records) {
        if (record.type === "childList") {
          for (const addedNode of Array.from(record.addedNodes ?? [])) {
            documirrorReconcileSubtree(addedNode, manifest);
          }
          continue;
        }

        if (record.type === "characterData") {
          documirrorReconcileTextNode(record.target, manifest);
          continue;
        }

        if (record.type === "attributes") {
          documirrorReconcileElementAttributes(record.target, manifest);
        }
      }
    });
  });

  state.observer = observer;
  state.observeTarget = windowObject.document.body;
  state.observeOptions = observeOptions;
  observer.observe?.(windowObject.document.body, observeOptions);
}

function documirrorRunReconcilePass(
  windowObject: RuntimeWindowLike | null | undefined,
  state: RuntimeObserverState | null | undefined,
): void {
  const root = windowObject?.document?.body ?? null;
  if (!root || !state?.manifest) {
    return;
  }

  const manifest = state.manifest;
  documirrorRunWithObserverPaused(state, () => {
    documirrorReconcileSubtree(root, manifest);
  });
}

function documirrorRuntimeLoader(
  windowObject: RuntimeWindowLike | null | undefined,
  stateKey: string,
  dataScriptId: string,
): void {
  if (!windowObject || !windowObject.document) {
    return;
  }

  const manifest = documirrorReadManifestFromDataScript(
    windowObject,
    dataScriptId,
  );
  if (!manifest) {
    return;
  }

  const state: RuntimeObserverState =
    windowObject[stateKey] && typeof windowObject[stateKey] === "object"
      ? (windowObject[stateKey] as RuntimeObserverState)
      : {};
  state.manifest = manifest;
  windowObject[stateKey] = state;

  if (state.started) {
    return;
  }

  state.started = true;
  documirrorRunReconcilePass(windowObject, state);
  windowObject.addEventListener?.(
    "DOMContentLoaded",
    () => documirrorRunReconcilePass(windowObject, state),
    { once: true },
  );
  windowObject.addEventListener?.(
    "load",
    () => documirrorRunReconcilePass(windowObject, state),
    { once: true },
  );
  documirrorAttachObserver(windowObject, state);
}

const RUNTIME_ASSET_FUNCTIONS = [
  documirrorRuntimeAttributeNames,
  documirrorIgnoredTagNames,
  documirrorGetChildNodes,
  documirrorHasIgnoredAncestor,
  documirrorReconcileTextNode,
  documirrorReconcileElementAttributes,
  documirrorReconcileSubtree,
  documirrorReadManifestFromDataScript,
  documirrorRunWithObserverPaused,
  documirrorAttachObserver,
  documirrorRunReconcilePass,
];
