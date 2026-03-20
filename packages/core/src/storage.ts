import fs from "fs-extra";
import { dirname } from "pathe";
import type { ZodType } from "zod";

import type {
  AssemblyMap,
  JsonValue,
  Manifest,
  MirrorConfig,
  SegmentRecord,
  TranslationRecord,
} from "@documirror/shared";
import {
  manifestSchema,
  mirrorConfigSchema,
  segmentRecordSchema,
  translationRecordSchema,
} from "@documirror/shared";

import { assemblyMapsSchema } from "./schemas";
import type { RepoPaths } from "./types";

export async function ensureRepoStructure(paths: RepoPaths): Promise<void> {
  await Promise.all([
    fs.ensureDir(paths.docuRoot),
    fs.ensureDir(dirname(paths.configPath)),
    fs.ensureDir(dirname(paths.manifestPath)),
    fs.ensureDir(dirname(paths.assemblyPath)),
    fs.ensureDir(paths.taskMappingsDir),
    fs.ensureDir(paths.pagesCacheDir),
    fs.ensureDir(paths.assetsCacheDir),
    fs.ensureDir(dirname(paths.segmentsPath)),
    fs.ensureDir(dirname(paths.translationsPath)),
    fs.ensureDir(paths.tasksPendingDir),
    fs.ensureDir(paths.tasksInProgressDir),
    fs.ensureDir(paths.tasksDoneDir),
    fs.ensureDir(paths.tasksAppliedDir),
    fs.ensureDir(paths.tasksAppliedHistoryDir),
    fs.ensureDir(paths.reportsDir),
  ]);
}

export async function loadConfig(paths: RepoPaths): Promise<MirrorConfig> {
  return mirrorConfigSchema.parse(await readJson(paths.configPath, {}));
}

export async function loadManifest(paths: RepoPaths): Promise<Manifest> {
  return manifestSchema.parse(await readJson(paths.manifestPath, {}));
}

export async function loadSegments(paths: RepoPaths): Promise<SegmentRecord[]> {
  return readJsonl(paths.segmentsPath, segmentRecordSchema);
}

export async function loadTranslations(
  paths: RepoPaths,
): Promise<TranslationRecord[]> {
  return readJsonl(paths.translationsPath, translationRecordSchema);
}

export async function loadAssemblyMaps(
  paths: RepoPaths,
): Promise<AssemblyMap[]> {
  return assemblyMapsSchema.parse(await readJson(paths.assemblyPath, []));
}

export async function writeJson(
  path: string,
  value: JsonValue | object | unknown[],
): Promise<void> {
  await fs.ensureDir(dirname(path));
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!(await fs.pathExists(path))) {
    return fallback;
  }

  return (await fs.readJson(path)) as T;
}

export async function writeJsonl<T extends object>(
  path: string,
  values: T[],
): Promise<void> {
  await fs.ensureDir(dirname(path));
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await fs.writeFile(path, body ? `${body}\n` : "", "utf8");
}

export async function readJsonl<T>(
  path: string,
  schema: ZodType<T>,
): Promise<T[]> {
  if (!(await fs.pathExists(path))) {
    return [];
  }

  const content = await fs.readFile(path, "utf8");
  if (!content.trim()) {
    return [];
  }

  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => schema.parse(JSON.parse(line)));
}
