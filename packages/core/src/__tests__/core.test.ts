import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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

    const mirrorPackage = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf8"),
    ) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect(mirrorPackage.name).toBe("documirror-mirror-docs-example-com-zh-cn");
    expect(mirrorPackage.scripts["documirror:update"]).toBe(
      "documirror update --repo .",
    );

    const mirrorReadme = await readFile(join(repoDir, "README.md"), "utf8");
    expect(mirrorReadme).toContain("Source site: https://docs.example.com");
    expect(mirrorReadme).toContain("pnpm documirror:update");

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

  it("merges missing package.json fields without overwriting existing scripts", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify(
        {
          name: "existing-mirror",
          scripts: {
            dev: "vite dev",
            "documirror:update": "custom update command",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    const mirrorPackage = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf8"),
    ) as {
      name: string;
      packageManager?: string;
      scripts: Record<string, string>;
    };

    expect(mirrorPackage.name).toBe("existing-mirror");
    expect(mirrorPackage.packageManager).toBe("pnpm@10.22.0");
    expect(mirrorPackage.scripts.dev).toBe("vite dev");
    expect(mirrorPackage.scripts["documirror:update"]).toBe(
      "custom update command",
    );
    expect(mirrorPackage.scripts["documirror:crawl"]).toBe(
      "documirror crawl --repo .",
    );
    expect(mirrorPackage.scripts["documirror:build"]).toBe(
      "documirror build --repo .",
    );
  });

  it("preserves existing mirror state when init is re-run", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    const configPath = join(repoDir, ".documirror", "config.json");
    const manifestPath = join(repoDir, ".documirror", "state", "manifest.json");
    const segmentsPath = join(
      repoDir,
      ".documirror",
      "content",
      "segments.jsonl",
    );
    const translationsPath = join(
      repoDir,
      ".documirror",
      "content",
      "translations.jsonl",
    );
    const taskGuidePath = join(repoDir, ".documirror", "TASKS.md");

    await writeFile(
      configPath,
      JSON.stringify(
        {
          sourceUrl: "https://docs.example.com",
          targetLocale: "zh-CN",
          selectors: {
            include: ["main"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          sourceUrl: "https://docs.example.com/custom",
          targetLocale: "zh-TW",
          generatedAt: "custom-manifest",
          pages: {},
          assets: {},
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(segmentsPath, '{"custom":"segment"}\n', "utf8");
    await writeFile(translationsPath, '{"custom":"translation"}\n', "utf8");
    await writeFile(taskGuidePath, "custom task guide\n", "utf8");

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      sourceUrl: string;
      targetLocale: string;
      selectors: {
        include: string[];
        exclude: string[];
      };
      build: {
        basePath: string;
      };
    };
    const manifest = await readFile(manifestPath, "utf8");

    expect(config.sourceUrl).toBe("https://docs.example.com");
    expect(config.selectors.include).toEqual(["main"]);
    expect(config.selectors.exclude).toContain("script");
    expect(config.build.basePath).toBe("/");
    expect(manifest).toContain('"generatedAt": "custom-manifest"');
    expect(await readFile(segmentsPath, "utf8")).toBe('{"custom":"segment"}\n');
    expect(await readFile(translationsPath, "utf8")).toBe(
      '{"custom":"translation"}\n',
    );
    expect(await readFile(taskGuidePath, "utf8")).toBe("custom task guide\n");
  });

  it("retains valid pending tasks when translate plan is re-run", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    const snapshotPath = join(
      repoDir,
      ".documirror",
      "cache",
      "pages",
      "index.html",
    );
    await writeFile(
      snapshotPath,
      `<!doctype html><html><head><title>Docs</title></head><body><main><h1>Hello world</h1></main></body></html>`,
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

    await extractMirror(repoDir);
    await planTranslations(repoDir);

    const taskDir = join(repoDir, ".documirror", "tasks", "pending");
    const [firstTaskFile] = await readdir(taskDir);
    const firstTaskBody = await readFile(join(taskDir, firstTaskFile), "utf8");

    const secondPlan = await planTranslations(repoDir);
    const taskFiles = await readdir(taskDir);

    expect(secondPlan.taskCount).toBe(1);
    expect(taskFiles).toEqual([firstTaskFile]);
    expect(await readFile(join(taskDir, firstTaskFile), "utf8")).toBe(
      firstTaskBody,
    );
  });
});
