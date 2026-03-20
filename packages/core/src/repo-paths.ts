import { join } from "pathe";

import { DOCUMIRROR_DIR } from "@documirror/shared";

import type { RepoPaths } from "./types";

export function getRepoPaths(repoDir: string): RepoPaths {
  const docuRoot = join(repoDir, DOCUMIRROR_DIR);

  return {
    docuRoot,
    envPath: join(repoDir, ".env"),
    gitIgnorePath: join(repoDir, ".gitignore"),
    configPath: join(docuRoot, "config.json"),
    manifestPath: join(docuRoot, "state", "manifest.json"),
    assemblyPath: join(docuRoot, "state", "assembly.json"),
    glossaryPath: join(docuRoot, "glossary.json"),
    taskManifestPath: join(docuRoot, "tasks", "manifest.json"),
    taskQueuePath: join(docuRoot, "tasks", "QUEUE.md"),
    taskMappingsDir: join(docuRoot, "state", "task-mappings"),
    pagesCacheDir: join(docuRoot, "cache", "pages"),
    assetsCacheDir: join(docuRoot, "cache", "assets"),
    segmentsPath: join(docuRoot, "content", "segments.jsonl"),
    translationsPath: join(docuRoot, "content", "translations.jsonl"),
    tasksPendingDir: join(docuRoot, "tasks", "pending"),
    tasksInProgressDir: join(docuRoot, "tasks", "in-progress"),
    tasksDoneDir: join(docuRoot, "tasks", "done"),
    tasksAppliedDir: join(docuRoot, "tasks", "applied"),
    tasksAppliedHistoryDir: join(docuRoot, "tasks", "applied", "history"),
    reportsDir: join(repoDir, "reports"),
  };
}
