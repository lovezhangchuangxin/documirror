import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyTranslations,
  buildMirror,
  extractMirror,
  initMirrorRepository,
  planTranslations,
} from "@documirror/core";

const createdDirs: string[] = [];

describe("documirror core pipeline", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("extracts segments, plans tasks, applies results, and builds translated html", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    const snapshotDir = join(repoDir, ".documirror", "cache", "pages");
    const snapshotPath = join(snapshotDir, "index.html");
    await writeFile(
      snapshotPath,
      `<!doctype html><html><head><title>Docs</title></head><body><h1>Hello world</h1><img alt="Hero image" src="/hero.png" /></body></html>`,
      "utf8",
    );

    await writeFile(
      join(repoDir, ".documirror", "state", "manifest.json"),
      JSON.stringify(
        {
          sourceUrl: "https://docs.example.com/",
          targetLocale: "zh-CN",
          generatedAt: new Date().toISOString(),
          pages: {
            "https://docs.example.com/": {
              url: "https://docs.example.com/",
              canonicalUrl: "https://docs.example.com/",
              status: 200,
              contentType: "text/html",
              snapshotPath: ".documirror/cache/pages/index.html",
              outputPath: "index.html",
              pageHash: "hash",
              discoveredFrom: null,
              assetRefs: [],
            },
          },
          assets: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const extractSummary = await extractMirror(repoDir);
    expect(extractSummary.segmentCount).toBeGreaterThan(0);

    const planSummary = await planTranslations(repoDir);
    expect(planSummary.taskCount).toBe(1);

    const taskDir = join(repoDir, ".documirror", "tasks", "pending");
    const [taskFileName] = await (
      await import("node:fs/promises")
    ).readdir(taskDir);
    const task = JSON.parse(
      await readFile(join(taskDir, taskFileName), "utf8"),
    ) as {
      taskId: string;
      items: Array<{
        segmentId: string;
        sourceHash: string;
        sourceText: string;
      }>;
    };

    await writeFile(
      join(repoDir, ".documirror", "tasks", "done", `${task.taskId}.json`),
      JSON.stringify(
        {
          schemaVersion: 1,
          taskId: task.taskId,
          provider: "test-provider",
          completedAt: new Date().toISOString(),
          items: task.items.map((item) => ({
            segmentId: item.segmentId,
            sourceHash: item.sourceHash,
            translatedText: `ZH:${item.sourceText}`,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedSegments).toBe(task.items.length);

    const buildSummary = await buildMirror(repoDir);
    expect(buildSummary.pageCount).toBe(1);

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain("ZH:Hello world");
    expect(builtHtml).toContain('lang="zh-CN"');
  });
});
