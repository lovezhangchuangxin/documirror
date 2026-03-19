import {
  createTaskFile,
  createTaskItems,
  parseResultFile,
} from "@documirror/adapters-filequeue";
import { crawlWebsite } from "@documirror/crawler";
import {
  chunkSegments,
  findPendingSegments,
  markStaleTranslations,
} from "@documirror/i18n";
import { extractSegmentsFromHtml } from "@documirror/parser";
import {
  DOCUMIRROR_DIR,
  type AssemblyMap,
  type JsonValue,
  type Logger,
  type Manifest,
  type MirrorConfig,
  type PageRecord,
  type SegmentRecord,
  type TranslationRecord,
  createCacheFileName,
  createTimestamp,
  defaultLogger,
  hashString,
  manifestSchema,
  mirrorConfigSchema,
  segmentRecordSchema,
  translationRecordSchema,
} from "@documirror/shared";
import { buildSite } from "@documirror/site-builder";
import {
  createDefaultConfig,
  createMirrorRepoPackageJson,
  createMirrorRepoReadme,
  createTaskGuide,
} from "@documirror/templates";
import fg from "fast-glob";
import fs from "fs-extra";
import { nanoid } from "nanoid";
import { dirname, join, relative } from "pathe";
import { z } from "zod";

const assemblyMapsSchema = z.array(
  z.object({
    pageUrl: z.string(),
    bindings: z.array(
      z.object({
        segmentId: z.string(),
        domPath: z.string(),
        kind: z.enum(["text", "attr", "meta"]),
        attributeName: z.string().optional(),
      }),
    ),
  }),
);

type RepoPaths = {
  docuRoot: string;
  configPath: string;
  manifestPath: string;
  assemblyPath: string;
  glossaryPath: string;
  pagesCacheDir: string;
  assetsCacheDir: string;
  segmentsPath: string;
  translationsPath: string;
  tasksPendingDir: string;
  tasksInProgressDir: string;
  tasksDoneDir: string;
  tasksAppliedDir: string;
  reportsDir: string;
};

export type InitOptions = {
  repoDir: string;
  siteUrl: string;
  targetLocale: string;
  logger?: Logger;
};

export type CrawlSummary = {
  pageCount: number;
  assetCount: number;
};

export type ExtractSummary = {
  pageCount: number;
  segmentCount: number;
};

export type PlanSummary = {
  taskCount: number;
  segmentCount: number;
};

export type ApplySummary = {
  appliedFiles: number;
  appliedSegments: number;
};

export type DoctorSummary = {
  pageCount: number;
  segmentCount: number;
  translatedSegmentCount: number;
  missingTranslationCount: number;
  staleTranslationCount: number;
  missingSnapshotCount: number;
  reportPath: string;
};

export type MirrorStatus = {
  sourceUrl: string;
  targetLocale: string;
  pageCount: number;
  assetCount: number;
  segmentCount: number;
  acceptedTranslationCount: number;
  staleTranslationCount: number;
  pendingTaskCount: number;
  doneTaskCount: number;
};

export async function initMirrorRepository(
  options: InitOptions,
): Promise<void> {
  const { repoDir, siteUrl, targetLocale } = options;
  const logger = options.logger ?? defaultLogger;
  const paths = getRepoPaths(repoDir);

  await ensureRepoStructure(paths);

  const config = mirrorConfigSchema.parse(
    createDefaultConfig(siteUrl, targetLocale),
  );
  await writeJson(paths.configPath, config);
  await writeJson(
    paths.manifestPath,
    manifestSchema.parse({
      sourceUrl: config.sourceUrl,
      targetLocale: config.targetLocale,
      generatedAt: createTimestamp(),
      pages: {},
      assets: {},
    }),
  );
  await writeJson(paths.assemblyPath, []);
  await writeJson(paths.glossaryPath, []);
  await fs.writeFile(paths.segmentsPath, "", "utf8");
  await fs.writeFile(paths.translationsPath, "", "utf8");
  await fs.writeFile(
    join(paths.docuRoot, "TASKS.md"),
    createTaskGuide(),
    "utf8",
  );
  await writeOrMergeScaffoldJson(
    join(repoDir, "package.json"),
    createMirrorRepoPackageJson(siteUrl, targetLocale),
    logger,
  );
  await writeScaffoldTextIfMissing(
    join(repoDir, "README.md"),
    createMirrorRepoReadme(siteUrl, targetLocale),
    logger,
  );
  logger.info(`Initialized mirror repository in ${repoDir}`);
}

export async function crawlMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<CrawlSummary> {
  const paths = getRepoPaths(repoDir);
  await ensureRepoStructure(paths);
  const config = await loadConfig(paths);
  const crawlResult = await crawlWebsite(config, logger);

  const manifest: Manifest = manifestSchema.parse({
    sourceUrl: config.sourceUrl,
    targetLocale: config.targetLocale,
    generatedAt: createTimestamp(),
    pages: {},
    assets: {},
  });

  for (const page of crawlResult.pages) {
    const snapshotRelativePath = relative(
      repoDir,
      join(paths.pagesCacheDir, createCacheFileName(page.url, ".html")),
    );
    const snapshotPath = join(repoDir, snapshotRelativePath);
    await fs.ensureDir(dirname(snapshotPath));
    await fs.writeFile(snapshotPath, page.html, "utf8");

    const record: PageRecord = {
      url: page.url,
      canonicalUrl: page.canonicalUrl,
      status: page.status,
      contentType: page.contentType,
      snapshotPath: snapshotRelativePath,
      outputPath: page.outputPath,
      pageHash: hashString(page.html),
      discoveredFrom: page.discoveredFrom,
      assetRefs: page.assetRefs,
    };

    manifest.pages[page.url] = record;
  }

  for (const asset of crawlResult.assets) {
    const cacheRelativePath = relative(
      repoDir,
      join(paths.assetsCacheDir, asset.outputPath),
    );
    const cachePath = join(repoDir, cacheRelativePath);
    await fs.ensureDir(dirname(cachePath));
    await fs.writeFile(cachePath, asset.buffer);
    manifest.assets[asset.url] = {
      url: asset.url,
      cachePath: cacheRelativePath,
      outputPath: asset.outputPath,
      contentType: asset.contentType,
      contentHash: hashString(asset.buffer.toString("base64")),
    };
  }

  await writeJson(paths.manifestPath, manifestSchema.parse(manifest));
  return {
    pageCount: crawlResult.pages.length,
    assetCount: crawlResult.assets.length,
  };
}

export async function extractMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<ExtractSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);

  const segments: SegmentRecord[] = [];
  const assemblyMaps: AssemblyMap[] = [];

  for (const page of Object.values(manifest.pages)) {
    const html = await fs.readFile(join(repoDir, page.snapshotPath), "utf8");
    const extracted = extractSegmentsFromHtml(html, page.url, config);
    segments.push(...extracted.segments);
    assemblyMaps.push(extracted.assemblyMap);
    manifest.pages[page.url] = {
      ...page,
      extractedAt: createTimestamp(),
    };
    logger.info(
      `Extracted ${extracted.segments.length} segments from ${page.url}`,
    );
  }

  await writeJsonl(paths.segmentsPath, segments);
  await writeJson(paths.assemblyPath, assemblyMaps);
  await writeJson(paths.manifestPath, manifest);

  return {
    pageCount: Object.keys(manifest.pages).length,
    segmentCount: segments.length,
  };
}

export async function planTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<PlanSummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segments = await loadSegments(paths);
  const currentTranslations = await loadTranslations(paths);
  const translations = markStaleTranslations(segments, currentTranslations);
  await writeJsonl(paths.translationsPath, translations);

  const pendingSegments = findPendingSegments(segments, translations);
  const pendingChunks = chunkSegments(pendingSegments);
  const glossary = await readJson<JsonValue[]>(paths.glossaryPath, []);

  await fs.emptyDir(paths.tasksPendingDir);
  let taskCount = 0;
  for (const chunk of pendingChunks) {
    const taskId = `task_${nanoid(10)}`;
    const task = createTaskFile(
      taskId,
      config.sourceUrl,
      config.targetLocale,
      createTaskItems(chunk),
    );
    const enrichedTask = {
      ...task,
      glossary,
    };
    await writeJson(
      join(paths.tasksPendingDir, `${taskId}.json`),
      enrichedTask,
    );
    taskCount += 1;
  }

  logger.info(
    `Planned ${pendingSegments.length} segments across ${taskCount} tasks`,
  );
  return {
    taskCount,
    segmentCount: pendingSegments.length,
  };
}

export async function applyTranslations(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<ApplySummary> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const segments = await loadSegments(paths);
  const segmentIndex = new Map(
    segments.map((segment) => [segment.segmentId, segment]),
  );
  const translations = await loadTranslations(paths);
  const translationIndex = new Map(
    translations.map((translation) => [translation.segmentId, translation]),
  );
  const files = await fg("*.json", { cwd: paths.tasksDoneDir, absolute: true });

  let appliedFiles = 0;
  let appliedSegments = 0;

  for (const filePath of files) {
    const parsed = parseResultFile(await readJson(filePath, {}));
    for (const item of parsed.items) {
      const segment = segmentIndex.get(item.segmentId);
      if (!segment) {
        logger.warn(
          `Skipping unknown segment ${item.segmentId} in ${filePath}`,
        );
        continue;
      }

      if (segment.sourceHash !== item.sourceHash) {
        logger.warn(
          `Skipping stale translation for ${item.segmentId} in ${filePath}`,
        );
        continue;
      }

      translationIndex.set(item.segmentId, {
        segmentId: item.segmentId,
        targetLocale: config.targetLocale,
        translatedText: item.translatedText,
        sourceHash: item.sourceHash,
        status: "accepted",
        provider: parsed.provider,
        updatedAt: parsed.completedAt,
      });
      appliedSegments += 1;
    }

    appliedFiles += 1;
    await fs.move(
      filePath,
      join(paths.tasksAppliedDir, `${parsed.taskId}.json`),
      { overwrite: true },
    );
  }

  await writeJsonl(paths.translationsPath, [...translationIndex.values()]);
  return {
    appliedFiles,
    appliedSegments,
  };
}

export async function buildMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<Awaited<ReturnType<typeof buildSite>>> {
  const paths = getRepoPaths(repoDir);
  const config = await loadConfig(paths);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const assemblyMaps = await loadAssemblyMaps(paths);
  const translations = await loadTranslations(paths);

  return buildSite({
    repoDir,
    config,
    manifest,
    segments,
    assemblyMaps,
    translations,
    logger,
  });
}

export async function updateMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
): Promise<{
  crawl: CrawlSummary;
  extract: ExtractSummary;
  plan: PlanSummary;
}> {
  const crawl = await crawlMirror(repoDir, logger);
  const extract = await extractMirror(repoDir, logger);
  const plan = await planTranslations(repoDir, logger);
  return { crawl, extract, plan };
}

export async function doctorMirror(repoDir: string): Promise<DoctorSummary> {
  const paths = getRepoPaths(repoDir);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const translations = await loadTranslations(paths);

  const currentSourceHashes = new Map(
    segments.map((segment) => [segment.segmentId, segment.sourceHash]),
  );
  const acceptedTranslations = translations.filter(
    (translation) =>
      translation.status === "accepted" &&
      currentSourceHashes.get(translation.segmentId) === translation.sourceHash,
  );
  const staleTranslations = translations.filter(
    (translation) =>
      translation.status === "stale" ||
      currentSourceHashes.get(translation.segmentId) !== translation.sourceHash,
  );
  const missingTranslationCount = segments.filter((segment) => {
    const translation = acceptedTranslations.find(
      (candidate) => candidate.segmentId === segment.segmentId,
    );
    return !translation;
  }).length;

  let missingSnapshotCount = 0;
  for (const page of Object.values(manifest.pages)) {
    if (!(await fs.pathExists(join(repoDir, page.snapshotPath)))) {
      missingSnapshotCount += 1;
    }
  }

  const report = {
    generatedAt: createTimestamp(),
    sourceUrl: manifest.sourceUrl,
    targetLocale: manifest.targetLocale,
    pageCount: Object.keys(manifest.pages).length,
    assetCount: Object.keys(manifest.assets).length,
    segmentCount: segments.length,
    translatedSegmentCount: acceptedTranslations.length,
    missingTranslationCount,
    staleTranslationCount: staleTranslations.length,
    missingSnapshotCount,
  };
  const reportPath = join(paths.reportsDir, "doctor-latest.json");
  await writeJson(reportPath, report);

  return {
    pageCount: report.pageCount,
    segmentCount: report.segmentCount,
    translatedSegmentCount: report.translatedSegmentCount,
    missingTranslationCount: report.missingTranslationCount,
    staleTranslationCount: report.staleTranslationCount,
    missingSnapshotCount: report.missingSnapshotCount,
    reportPath,
  };
}

export async function getMirrorStatus(repoDir: string): Promise<MirrorStatus> {
  const paths = getRepoPaths(repoDir);
  const manifest = await loadManifest(paths);
  const segments = await loadSegments(paths);
  const translations = await loadTranslations(paths);
  const pendingTasks = await fg("*.json", { cwd: paths.tasksPendingDir });
  const doneTasks = await fg("*.json", { cwd: paths.tasksDoneDir });

  return {
    sourceUrl: manifest.sourceUrl,
    targetLocale: manifest.targetLocale,
    pageCount: Object.keys(manifest.pages).length,
    assetCount: Object.keys(manifest.assets).length,
    segmentCount: segments.length,
    acceptedTranslationCount: translations.filter(
      (translation) => translation.status === "accepted",
    ).length,
    staleTranslationCount: translations.filter(
      (translation) => translation.status === "stale",
    ).length,
    pendingTaskCount: pendingTasks.length,
    doneTaskCount: doneTasks.length,
  };
}

async function loadConfig(paths: RepoPaths): Promise<MirrorConfig> {
  return mirrorConfigSchema.parse(await readJson(paths.configPath, {}));
}

async function loadManifest(paths: RepoPaths): Promise<Manifest> {
  return manifestSchema.parse(await readJson(paths.manifestPath, {}));
}

async function loadSegments(paths: RepoPaths): Promise<SegmentRecord[]> {
  return readJsonl(paths.segmentsPath, segmentRecordSchema);
}

async function loadTranslations(
  paths: RepoPaths,
): Promise<TranslationRecord[]> {
  return readJsonl(paths.translationsPath, translationRecordSchema);
}

async function loadAssemblyMaps(paths: RepoPaths): Promise<AssemblyMap[]> {
  return assemblyMapsSchema.parse(await readJson(paths.assemblyPath, []));
}

async function ensureRepoStructure(paths: RepoPaths): Promise<void> {
  await Promise.all([
    fs.ensureDir(paths.docuRoot),
    fs.ensureDir(dirname(paths.configPath)),
    fs.ensureDir(dirname(paths.manifestPath)),
    fs.ensureDir(dirname(paths.assemblyPath)),
    fs.ensureDir(paths.pagesCacheDir),
    fs.ensureDir(paths.assetsCacheDir),
    fs.ensureDir(dirname(paths.segmentsPath)),
    fs.ensureDir(dirname(paths.translationsPath)),
    fs.ensureDir(paths.tasksPendingDir),
    fs.ensureDir(paths.tasksInProgressDir),
    fs.ensureDir(paths.tasksDoneDir),
    fs.ensureDir(paths.tasksAppliedDir),
    fs.ensureDir(paths.reportsDir),
  ]);
}

function getRepoPaths(repoDir: string): RepoPaths {
  const docuRoot = join(repoDir, DOCUMIRROR_DIR);

  return {
    docuRoot,
    configPath: join(docuRoot, "config.json"),
    manifestPath: join(docuRoot, "state", "manifest.json"),
    assemblyPath: join(docuRoot, "state", "assembly.json"),
    glossaryPath: join(docuRoot, "glossary.json"),
    pagesCacheDir: join(docuRoot, "cache", "pages"),
    assetsCacheDir: join(docuRoot, "cache", "assets"),
    segmentsPath: join(docuRoot, "content", "segments.jsonl"),
    translationsPath: join(docuRoot, "content", "translations.jsonl"),
    tasksPendingDir: join(docuRoot, "tasks", "pending"),
    tasksInProgressDir: join(docuRoot, "tasks", "in-progress"),
    tasksDoneDir: join(docuRoot, "tasks", "done"),
    tasksAppliedDir: join(docuRoot, "tasks", "applied"),
    reportsDir: join(repoDir, "reports"),
  };
}

async function writeJson(
  path: string,
  value: JsonValue | object | unknown[],
): Promise<void> {
  await fs.ensureDir(dirname(path));
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!(await fs.pathExists(path))) {
    return fallback;
  }

  return (await fs.readJson(path)) as T;
}

async function writeJsonl<T extends object>(
  path: string,
  values: T[],
): Promise<void> {
  await fs.ensureDir(dirname(path));
  const body = values.map((value) => JSON.stringify(value)).join("\n");
  await fs.writeFile(path, body ? `${body}\n` : "", "utf8");
}

async function readJsonl<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
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

async function writeOrMergeScaffoldJson(
  path: string,
  value: JsonValue | object | unknown[],
  logger: Logger,
): Promise<void> {
  if (!(await fs.pathExists(path))) {
    await writeJson(path, value);
    return;
  }

  const existing = await readJson<JsonValue | object | unknown[]>(path, {});
  const merged = mergeMissingValues(existing, value);
  await writeJson(path, merged);
  logger.info(
    `Merged missing scaffold fields into ${relative(process.cwd(), path)}`,
  );
}

async function writeScaffoldTextIfMissing(
  path: string,
  value: string,
  logger: Logger,
): Promise<void> {
  if (await fs.pathExists(path)) {
    logger.warn(
      `Skipped existing scaffold file: ${relative(process.cwd(), path)}`,
    );
    return;
  }

  await fs.ensureDir(dirname(path));
  await fs.writeFile(path, value, "utf8");
}

function mergeMissingValues(
  existing: JsonValue | object | unknown[],
  scaffold: JsonValue | object | unknown[],
): JsonValue | object | unknown[] {
  if (Array.isArray(existing) || Array.isArray(scaffold)) {
    return existing;
  }

  if (isPlainObject(existing) && isPlainObject(scaffold)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, scaffoldValue] of Object.entries(scaffold)) {
      const existingValue = merged[key];
      if (existingValue === undefined) {
        merged[key] = scaffoldValue;
        continue;
      }

      if (isPlainObject(existingValue) && isPlainObject(scaffoldValue)) {
        merged[key] = mergeMissingValues(existingValue, scaffoldValue);
      }
    }

    return merged;
  }

  return existing;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
