import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyTranslations,
  buildMirror,
  claimTranslationTask,
  completeTranslationTask,
  extractMirror,
  initMirrorRepository,
  planTranslations,
  verifyTranslationTask,
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
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility together</p><img alt="Hero image" src="/hero.png" /></body></html>`,
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
    const queueManifest = JSON.parse(
      await readFile(
        join(repoDir, ".documirror", "tasks", "manifest.json"),
        "utf8",
      ),
    ) as {
      summary: {
        pending: number;
        inProgress: number;
        done: number;
      };
      tasks: Array<{
        taskId: string;
        status: string;
      }>;
    };
    expect(queueManifest.summary.pending).toBe(1);
    expect(queueManifest.summary.inProgress).toBe(0);
    expect(queueManifest.summary.done).toBe(0);

    const taskDir = join(repoDir, ".documirror", "tasks", "pending");
    const [taskFileName] = await (
      await import("node:fs/promises")
    ).readdir(taskDir);
    const taskBody = await readFile(join(taskDir, taskFileName), "utf8");
    const task = JSON.parse(taskBody) as {
      taskId: string;
      page: {
        url: string;
        title?: string;
      };
      content: Array<{
        id: string;
        text: string;
        note?: string;
      }>;
    };
    const taskMappingPath = join(
      repoDir,
      ".documirror",
      "state",
      "task-mappings",
      `${task.taskId}.json`,
    );
    const taskMapping = JSON.parse(await readFile(taskMappingPath, "utf8")) as {
      items: Array<
        | {
            id: string;
            kind: "segment";
            segment: {
              segmentId: string;
              sourceHash: string;
            };
          }
        | {
            id: string;
            kind: "inline-code";
            segments: Array<{
              segmentId: string;
              sourceHash: string;
            }>;
            inlineCodeSpans: Array<{
              text: string;
            }>;
            textSlotIndices: number[];
          }
      >;
    };

    expect(task.page.url).toBe("https://docs.example.com/");
    expect(task.content[0]).toEqual({
      id: "1",
      text: "Use the `snap-always` utility together",
      note: "Treat text wrapped in backticks as code literals and keep it unchanged in the same order.",
    });
    expect(task.content[1]).toEqual({
      id: "2",
      text: "Hero image",
      note: "<img> @alt",
    });
    expect(taskBody).not.toContain("segmentId");
    expect(taskBody).not.toContain("sourceHash");
    expect(taskMapping.items[0]?.id).toBe("1");
    expect(taskMapping.items[0]).toEqual({
      id: "1",
      kind: "inline-code",
      segments: [
        expect.objectContaining({
          segmentId: expect.any(String),
          sourceHash: expect.any(String),
        }),
        expect.objectContaining({
          segmentId: expect.any(String),
          sourceHash: expect.any(String),
        }),
      ],
      inlineCodeSpans: [
        {
          text: "snap-always",
        },
      ],
      textSlotIndices: [0, 1],
    });
    expect(taskMapping.items[1]).toEqual({
      id: "2",
      kind: "segment",
      segment: expect.objectContaining({
        segmentId: expect.any(String),
        sourceHash: expect.any(String),
      }),
    });

    const claimSummary = await claimTranslationTask(repoDir);
    expect(claimSummary.taskId).toBe(task.taskId);
    expect(claimSummary.taskFile).toBe(
      `.documirror/tasks/pending/${task.taskId}.json`,
    );
    expect(claimSummary.draftResultFile).toBe(
      `.documirror/tasks/in-progress/${task.taskId}.result.json`,
    );
    await writeFile(
      join(
        repoDir,
        ".documirror",
        "tasks",
        "in-progress",
        `${task.taskId}.result.json`,
      ),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: task.taskId,
          translations: [
            {
              id: "1",
              translatedText: "一起使用 `snap-always` 工具",
            },
            {
              id: "2",
              translatedText: "主视觉图",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const verifySummary = await verifyTranslationTask(repoDir, task.taskId);
    expect(verifySummary.ok).toBe(true);

    const completeSummary = await completeTranslationTask(repoDir, {
      taskId: task.taskId,
      provider: "test-provider",
    });
    expect(completeSummary.resultFile).toBe(
      `.documirror/tasks/done/${task.taskId}.json`,
    );

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedSegments).toBe(3);
    expect(await readdir(taskDir)).toEqual([]);
    expect(
      await readFile(
        join(repoDir, ".documirror", "tasks", "applied", `${task.taskId}.json`),
        "utf8",
      ),
    ).toContain('"schemaVersion": 2');
    expect(
      await readFile(
        join(
          repoDir,
          ".documirror",
          "tasks",
          "applied",
          `${task.taskId}.mapping.json`,
        ),
        "utf8",
      ),
    ).toContain('"segmentId"');
    expect(
      await readFile(
        join(
          repoDir,
          ".documirror",
          "tasks",
          "applied",
          `${task.taskId}.task.json`,
        ),
        "utf8",
      ),
    ).toContain('"taskId"');
    expect(
      JSON.parse(
        await readFile(
          join(repoDir, ".documirror", "tasks", "manifest.json"),
          "utf8",
        ),
      ) as {
        summary: {
          applied: number;
        };
      },
    ).toEqual(
      expect.objectContaining({
        summary: expect.objectContaining({
          applied: 1,
        }),
      }),
    );

    const buildSummary = await buildMirror(repoDir);
    expect(buildSummary.pageCount).toBe(1);

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain("一起使用 <code>snap-always</code> 工具");
    expect(builtHtml).toContain('alt="主视觉图"');
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
    expect(mirrorPackage.scripts["documirror:translate:claim"]).toBe(
      "documirror translate claim --repo .",
    );
    expect(mirrorPackage.scripts["documirror:translate:verify"]).toBe(
      "documirror translate verify --repo .",
    );
    expect(mirrorPackage.scripts["documirror:translate:complete"]).toBe(
      "documirror translate complete --repo .",
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
    const taskManifestPath = join(
      repoDir,
      ".documirror",
      "tasks",
      "manifest.json",
    );
    const taskQueuePath = join(repoDir, ".documirror", "tasks", "QUEUE.md");
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
    await writeFile(taskManifestPath, '{"custom":"task-manifest"}\n', "utf8");
    await writeFile(taskQueuePath, "custom task queue\n", "utf8");
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
    expect(await readFile(taskManifestPath, "utf8")).toBe(
      '{"custom":"task-manifest"}\n',
    );
    expect(await readFile(taskQueuePath, "utf8")).toBe("custom task queue\n");
    expect(await readFile(taskGuidePath, "utf8")).toBe("custom task guide\n");
  });

  it("reports actionable verification errors for invalid draft results", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    await writeFile(
      join(repoDir, ".documirror", "cache", "pages", "index.html"),
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility together</p></body></html>`,
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
    const claimSummary = await claimTranslationTask(repoDir);

    await writeFile(
      join(
        repoDir,
        ".documirror",
        "tasks",
        "in-progress",
        `${claimSummary.taskId}.result.json`,
      ),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: claimSummary.taskId,
          translations: [
            {
              id: "1",
              translatedText: "使用 snap-always 工具",
            },
            {
              id: "2",
              translatedText: "额外内容",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const verifySummary = await verifyTranslationTask(
      repoDir,
      claimSummary.taskId,
    );
    expect(verifySummary.ok).toBe(false);
    expect(verifySummary.errorCount).toBeGreaterThan(0);

    const report = JSON.parse(
      await readFile(join(repoDir, verifySummary.reportPath), "utf8"),
    ) as {
      errors: Array<{
        code: string;
        message: string;
      }>;
    };
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "id_unknown",
        }),
        expect.objectContaining({
          code: "translation_count_mismatch",
        }),
        expect.objectContaining({
          code: "inline_code_mismatch",
        }),
      ]),
    );
    expect(
      await readFile(join(repoDir, ".documirror", "tasks", "QUEUE.md"), "utf8"),
    ).toContain("verify fail");
  });

  it("rejects stale claimed tasks during verification", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
    });

    await writeFile(
      join(repoDir, ".documirror", "cache", "pages", "index.html"),
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
    const claimSummary = await claimTranslationTask(repoDir);

    await writeFile(
      join(
        repoDir,
        ".documirror",
        "tasks",
        "in-progress",
        `${claimSummary.taskId}.result.json`,
      ),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: claimSummary.taskId,
          translations: [
            {
              id: "1",
              translatedText: "你好，世界",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const segmentsPath = join(
      repoDir,
      ".documirror",
      "content",
      "segments.jsonl",
    );
    const staleSegments = (await readFile(segmentsPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .map((segment, index) =>
        index === 0
          ? {
              ...segment,
              sourceHash: "stale-source-hash",
            }
          : segment,
      );
    await writeFile(
      segmentsPath,
      `${staleSegments.map((segment) => JSON.stringify(segment)).join("\n")}\n`,
      "utf8",
    );

    const verifySummary = await verifyTranslationTask(
      repoDir,
      claimSummary.taskId,
    );
    expect(verifySummary.ok).toBe(false);
    expect(verifySummary.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "task_stale",
        }),
      ]),
    );
  });

  it("keeps full inline-code sentence context when only one surrounding segment is pending", async () => {
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
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility together</p></body></html>`,
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

    const segments = (
      await readFile(
        join(repoDir, ".documirror", "content", "segments.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)) as Array<{
      segmentId: string;
      sourceHash: string;
      sourceText: string;
    }>;
    const retainedSegment = segments.find(
      (segment) => segment.sourceText === " utility together",
    );
    expect(retainedSegment).toBeDefined();
    if (!retainedSegment) {
      throw new Error("Expected retained segment to exist");
    }

    await writeFile(
      join(repoDir, ".documirror", "content", "translations.jsonl"),
      `${JSON.stringify({
        segmentId: retainedSegment.segmentId,
        targetLocale: "zh-CN",
        translatedText: "工具一起使用",
        sourceHash: retainedSegment.sourceHash,
        status: "accepted",
        provider: "test-provider",
        updatedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const planSummary = await planTranslations(repoDir);
    expect(planSummary.segmentCount).toBe(1);

    const taskDir = join(repoDir, ".documirror", "tasks", "pending");
    const [taskFileName] = await readdir(taskDir);
    const task = JSON.parse(
      await readFile(join(taskDir, taskFileName), "utf8"),
    ) as {
      content: Array<{
        id: string;
        text: string;
      }>;
    };
    const taskId = taskFileName.replace(/\.json$/u, "");
    const taskMapping = JSON.parse(
      await readFile(
        join(
          repoDir,
          ".documirror",
          "state",
          "task-mappings",
          `${taskId}.json`,
        ),
        "utf8",
      ),
    ) as {
      items: Array<{
        kind: string;
        segments?: Array<{
          segmentId: string;
        }>;
      }>;
    };

    expect(task.content).toEqual([
      expect.objectContaining({
        id: "1",
        text: "Use the `snap-always` utility together",
      }),
    ]);
    expect(taskMapping.items[0]).toEqual({
      kind: "inline-code",
      id: "1",
      segments: [
        expect.objectContaining({
          segmentId: expect.any(String),
        }),
        expect.objectContaining({
          segmentId: expect.any(String),
        }),
      ],
      inlineCodeSpans: [
        {
          text: "snap-always",
        },
      ],
      textSlotIndices: [0, 1],
    });
  });

  it("applies inline-code translations when code appears at the start or end of a sentence", async () => {
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
      `<!doctype html><html><head><title>Docs</title></head><body><p><code>snap-always</code> is enabled</p><p>Run <code>npm install</code></p></body></html>`,
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
    const [taskFileName] = await readdir(taskDir);
    const task = JSON.parse(
      await readFile(join(taskDir, taskFileName), "utf8"),
    ) as {
      taskId: string;
      content: Array<{
        id: string;
        text: string;
      }>;
    };

    expect(task.content).toEqual([
      expect.objectContaining({
        id: "1",
        text: "`snap-always` is enabled",
      }),
      expect.objectContaining({
        id: "2",
        text: "Run `npm install`",
      }),
    ]);

    await writeFile(
      join(repoDir, ".documirror", "tasks", "done", `${task.taskId}.json`),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: task.taskId,
          provider: "test-provider",
          completedAt: new Date().toISOString(),
          translations: [
            {
              id: "1",
              translatedText: "`snap-always` 已启用",
            },
            {
              id: "2",
              translatedText: "运行 `npm install`",
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedSegments).toBe(2);

    await buildMirror(repoDir);
    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain("<code>snap-always</code> 已启用");
    expect(builtHtml).toContain("运行 <code>npm install</code>");
  });

  it("skips unreadable legacy result files without aborting apply", async () => {
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
    const [taskFileName] = await readdir(taskDir);
    const task = JSON.parse(
      await readFile(join(taskDir, taskFileName), "utf8"),
    ) as {
      taskId: string;
      content: Array<{
        id: string;
        text: string;
      }>;
    };

    await writeFile(
      join(repoDir, ".documirror", "tasks", "done", "legacy.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          taskId: "legacy",
          provider: "legacy-provider",
          completedAt: new Date().toISOString(),
          items: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    await writeFile(
      join(repoDir, ".documirror", "tasks", "done", `${task.taskId}.json`),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: task.taskId,
          provider: "test-provider",
          completedAt: new Date().toISOString(),
          translations: task.content.map((item) => ({
            id: item.id,
            translatedText: `ZH:${item.text}`,
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedFiles).toBe(1);
    expect(
      await readFile(
        join(repoDir, ".documirror", "tasks", "done", "legacy.json"),
        "utf8",
      ),
    ).toContain('"schemaVersion": 1');
    expect(
      await readFile(
        join(repoDir, ".documirror", "tasks", "applied", `${task.taskId}.json`),
        "utf8",
      ),
    ).toContain('"schemaVersion": 2');
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
    const firstTask = JSON.parse(firstTaskBody) as {
      taskId: string;
    };
    const firstTaskMappingPath = join(
      repoDir,
      ".documirror",
      "state",
      "task-mappings",
      `${firstTask.taskId}.json`,
    );
    const firstTaskMappingBody = await readFile(firstTaskMappingPath, "utf8");

    const secondPlan = await planTranslations(repoDir);
    const taskFiles = await readdir(taskDir);

    expect(secondPlan.taskCount).toBe(1);
    expect(taskFiles).toEqual([firstTaskFile]);
    expect(await readFile(join(taskDir, firstTaskFile), "utf8")).toBe(
      firstTaskBody,
    );
    expect(await readFile(firstTaskMappingPath, "utf8")).toBe(
      firstTaskMappingBody,
    );
  });
});
