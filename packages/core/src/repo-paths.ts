import { join } from "pathe";

import { DOCUMIRROR_DIR } from "@documirror/shared";

import type { RepoPaths } from "./types";

export function getRepoPaths(repoDir: string): RepoPaths {
  const docuRoot = join(repoDir, DOCUMIRROR_DIR);

  return {
    docuRoot,
    configPath: join(docuRoot, "config.json"),
    manifestPath: join(docuRoot, "state", "manifest.json"),
    assemblyPath: join(docuRoot, "state", "assembly.json"),
    glossaryPath: join(docuRoot, "glossary.json"),
    taskMappingsDir: join(docuRoot, "state", "task-mappings"),
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
