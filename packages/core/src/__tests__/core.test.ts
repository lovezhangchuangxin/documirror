import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockTranslateTaskWithOpenAi = vi.fn();

vi.mock("@documirror/adapters-openai", () => ({
  testOpenAiConnection: vi.fn(async () => ({
    ok: true,
    message: "connected",
  })),
  translateTaskWithOpenAi: (...args: unknown[]) =>
    mockTranslateTaskWithOpenAi(...args),
}));

import {
  applyTranslations,
  buildMirror,
  extractMirror,
  getMirrorStatus,
  initMirrorRepository,
  planTranslations,
  runTranslations,
  verifyTranslationTask,
} from "@documirror/core";
import type { Logger, MirrorAiConfig } from "@documirror/shared";

const createdDirs: string[] = [];
const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

function createAiConfig(): MirrorAiConfig {
  return {
    providerKind: "openai-compatible",
    llmProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4.1-mini",
    authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
    concurrency: 2,
    requestTimeoutMs: 60_000,
    maxAttemptsPerTask: 2,
    temperature: 0.2,
    chunking: {
      enabled: true,
      strategy: "structural",
      maxItemsPerChunk: 80,
      softMaxSourceCharsPerChunk: 6_000,
      hardMaxSourceCharsPerChunk: 9_000,
    },
  };
}

function buildDraftFromTask(task: {
  taskId: string;
  content: Array<{ id: string; text: string }>;
}) {
  return {
    rawText: JSON.stringify({
      schemaVersion: 2,
      taskId: task.taskId,
      translations: task.content.map((item) => ({
        id: item.id,
        translatedText: `${item.text} zh`,
      })),
    }),
    draft: {
      schemaVersion: 2 as const,
      taskId: task.taskId,
      translations: task.content.map((item) => ({
        id: item.id,
        translatedText: `${item.text} zh`,
      })),
    },
  };
}

async function setupChunkedRunRepo(options: {
  pageSlugs: string[];
  concurrency: number;
}): Promise<string> {
  const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
  createdDirs.push(repoDir);

  await initMirrorRepository({
    repoDir,
    siteUrl: "https://docs.example.com",
    targetLocale: "zh-CN",
    ai: {
      ...createAiConfig(),
      concurrency: options.concurrency,
      chunking: {
        enabled: true,
        strategy: "structural",
        maxItemsPerChunk: 3,
        softMaxSourceCharsPerChunk: 1_000,
        hardMaxSourceCharsPerChunk: 2_000,
      },
    },
    authToken: "secret-token",
  });

  const pages = Object.fromEntries(
    await Promise.all(
      options.pageSlugs.map(async (slug, index) => {
        const snapshotName = index === 0 ? "index.html" : `${slug}.html`;
        const outputPath = index === 0 ? "index.html" : `${slug}/index.html`;
        const pageUrl =
          index === 0
            ? "https://docs.example.com/"
            : `https://docs.example.com/${slug}/`;

        await writeFile(
          join(repoDir, ".documirror", "cache", "pages", snapshotName),
          `<!doctype html><html><head><title>${slug}</title></head><body><h2>Install ${slug}</h2><p>Install the package ${slug}</p><p>Run the setup ${slug}</p><h2>Deploy ${slug}</h2><p>Deploy the site ${slug}</p><p>Check the output ${slug}</p></body></html>`,
          "utf8",
        );

        return [
          pageUrl,
          {
            url: pageUrl,
            canonicalUrl: pageUrl,
            status: 200,
            contentType: "text/html",
            snapshotPath: `.documirror/cache/pages/${snapshotName}`,
            outputPath,
            pageHash: `${slug}-hash`,
            discoveredFrom: null,
            assetRefs: [],
          },
        ] as const;
      }),
    ),
  );

  await writeFile(
    join(repoDir, ".documirror", "state", "manifest.json"),
    JSON.stringify(
      {
        sourceUrl: "https://docs.example.com/",
        targetLocale: "zh-CN",
        generatedAt: new Date().toISOString(),
        pages,
        assets: {},
      },
      null,
      2,
    ),
    "utf8",
  );

  await extractMirror(repoDir);
  await planTranslations(repoDir);

  return repoDir;
}

describe("documirror core pipeline", () => {
  beforeEach(() => {
    mockTranslateTaskWithOpenAi.mockReset();
  });

  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("initializes a repository with ai config and env scaffolding", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    const config = JSON.parse(
      await readFile(join(repoDir, ".documirror", "config.json"), "utf8"),
    ) as {
      ai: {
        modelName: string;
        authTokenEnvVar: string;
      };
    };
    const envBody = await readFile(join(repoDir, ".env"), "utf8");
    const gitIgnoreBody = await readFile(join(repoDir, ".gitignore"), "utf8");
    const mirrorPackage = JSON.parse(
      await readFile(join(repoDir, "package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    const mirrorReadme = await readFile(join(repoDir, "README.md"), "utf8");
    const mirrorAgents = await readFile(join(repoDir, "AGENTS.md"), "utf8");

    expect(config.ai.modelName).toBe("gpt-4.1-mini");
    expect(config.ai.authTokenEnvVar).toBe("DOCUMIRROR_AI_AUTH_TOKEN");
    expect(envBody).toContain("DOCUMIRROR_AI_AUTH_TOKEN=secret-token");
    expect(gitIgnoreBody).toContain(".env");
    expect(mirrorPackage.scripts["documirror:translate:run"]).toBe(
      "documirror translate run",
    );
    expect(mirrorPackage.scripts["documirror:auto"]).toBe("documirror auto");
    expect(mirrorPackage.scripts["documirror:config:ai"]).toBe(
      "documirror config ai",
    );
    expect(mirrorReadme).toContain("pnpm documirror:auto");
    expect(mirrorReadme).toContain("pnpm documirror:translate:run");
    expect(mirrorAgents).toContain(".env");
    expect(mirrorAgents).toContain("pnpm documirror:auto");
  });

  it("plans tasks, runs automatic translation, verifies, and applies results", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
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

    await extractMirror(repoDir);
    const planSummary = await planTranslations(repoDir);
    expect(planSummary.taskCount).toBe(1);

    mockTranslateTaskWithOpenAi.mockResolvedValue({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
          {
            id: "2",
            translatedText: "主视觉图片",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
          {
            id: "2",
            translatedText: "主视觉图片",
          },
        ],
      },
    });

    const progressEvents: Array<{ type: string }> = [];
    const debugMessages: string[] = [];
    const runSummary = await runTranslations(
      repoDir,
      silentLogger,
      (event) => {
        progressEvents.push({ type: event.type });
        if (event.type === "queued") {
          expect(event.concurrency).toBe(2);
          expect(event.provider).toBe("openai");
          expect(event.model).toBe("gpt-4.1-mini");
          expect(event.requestTimeoutMs).toBe(60_000);
        }
      },
      undefined,
      {
        onDebug(message) {
          debugMessages.push(message);
        },
      },
    );
    expect(runSummary.successCount).toBe(1);
    expect(runSummary.failureCount).toBe(0);
    expect(progressEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(["queued", "started", "attempt", "completed"]),
    );
    expect(debugMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining("loaded AI config: openai/gpt-4.1-mini"),
        expect.stringContaining("task_dc3d488a4e: attempt 1/2 sending request"),
        expect.stringContaining(
          "task_dc3d488a4e: attempt 1/2 received response after",
        ),
        expect.stringContaining(
          "task_dc3d488a4e: wrote done result and verification report",
        ),
      ]),
    );

    const doneDir = join(repoDir, ".documirror", "tasks", "done");
    const [resultFileName] = await readdir(doneDir);
    const result = JSON.parse(
      await readFile(join(doneDir, resultFileName), "utf8"),
    ) as {
      provider: string;
      model: string;
      translations: Array<{
        translatedText: string;
      }>;
    };
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1-mini");
    expect(result.translations[0]?.translatedText).toBe(
      "一起使用 `snap-always` 工具",
    );

    const taskId = resultFileName.replace(/\.json$/u, "");
    const verifySummary = await verifyTranslationTask(repoDir, taskId);
    expect(verifySummary.ok).toBe(true);

    const applySummary = await applyTranslations(repoDir, silentLogger, {
      profile: true,
    });
    expect(applySummary.appliedFiles).toBe(1);
    expect(applySummary.appliedSegments).toBeGreaterThan(0);
    expect(applySummary.profile?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining([
        "discover done results",
        "load and verify results",
        "apply translations and archive tasks",
        "write translations state",
        "sync task manifest",
      ]),
    );

    const translationsBody = await readFile(
      join(repoDir, ".documirror", "content", "translations.jsonl"),
      "utf8",
    );
    expect(translationsBody).toContain("主视觉图片");

    const status = await getMirrorStatus(repoDir);
    expect(status.pendingTaskCount).toBe(0);
    expect(status.doneTaskCount).toBe(0);
    expect(status.appliedTaskCount).toBe(1);
  });

  it("keeps failed tasks pending and writes a run failure report", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: {
        ...createAiConfig(),
        maxAttemptsPerTask: 2,
      },
      authToken: "secret-token",
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
    await planTranslations(repoDir);

    mockTranslateTaskWithOpenAi.mockResolvedValue({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 snap-always 工具",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 snap-always 工具",
          },
        ],
      },
    });

    const summary = await runTranslations(repoDir);
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(1);

    const reportBody = await readFile(
      join(repoDir, "reports", "translation-run", "task_dc3d488a4e.json"),
      "utf8",
    );
    expect(reportBody).toContain("inline_code_mismatch");

    const status = await getMirrorStatus(repoDir);
    expect(status.pendingTaskCount).toBe(1);
    expect(status.doneTaskCount).toBe(0);
  });

  it("passes normalized retry context after validation failures", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: {
        ...createAiConfig(),
        maxAttemptsPerTask: 2,
      },
      authToken: "secret-token",
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
    await planTranslations(repoDir);

    const invalidDraft = {
      schemaVersion: 2 as const,
      taskId: "task_dc3d488a4e",
      translations: [
        {
          id: "1",
          translatedText: "一起使用 snap-always 工具",
        },
      ],
    };
    const validDraft = {
      schemaVersion: 2 as const,
      taskId: "task_dc3d488a4e",
      translations: [
        {
          id: "1",
          translatedText: "一起使用 `snap-always` 工具",
        },
      ],
    };

    mockTranslateTaskWithOpenAi
      .mockResolvedValueOnce({
        rawText: `\`\`\`json\n${JSON.stringify(invalidDraft)}\n\`\`\``,
        draft: invalidDraft,
      })
      .mockResolvedValueOnce({
        rawText: JSON.stringify(validDraft),
        draft: validDraft,
      });

    const summary = await runTranslations(repoDir);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(mockTranslateTaskWithOpenAi).toHaveBeenCalledTimes(2);

    const secondCall = mockTranslateTaskWithOpenAi.mock.calls[1]?.[0] as {
      previousResponse?: string;
      verificationIssues?: Array<{ code: string; message: string }>;
    };
    expect(secondCall.previousResponse).toBe(
      JSON.stringify(invalidDraft, null, 2),
    );
    expect(secondCall.verificationIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "inline_code_mismatch",
          message: expect.stringContaining("snap-always"),
        }),
      ]),
    );
  });

  it("accepts reordered inline-code spans when the code set is preserved", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: {
        ...createAiConfig(),
        maxAttemptsPerTask: 2,
      },
      authToken: "secret-token",
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
      `<!doctype html><html><head><title>Docs</title></head><body><p>Here is a simple <code>&lt;input&gt;</code> with a correctly associated <code>&lt;label&gt;</code></p></body></html>`,
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

    const invalidDraft = {
      schemaVersion: 2 as const,
      taskId: "task_dc3d488a4e",
      translations: [
        {
          id: "1",
          translatedText: "这是带有正确关联 `<label>` 的简单 `<input>` 字段",
        },
      ],
    };

    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify(invalidDraft),
      draft: invalidDraft,
    });

    const summary = await runTranslations(repoDir);
    expect(summary.successCount).toBe(1);
    expect(summary.failureCount).toBe(0);
    expect(mockTranslateTaskWithOpenAi).toHaveBeenCalledTimes(1);
  });

  it("splits large page tasks into chunks and merges the final page result", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: {
        ...createAiConfig(),
        chunking: {
          enabled: true,
          strategy: "structural",
          maxItemsPerChunk: 3,
          softMaxSourceCharsPerChunk: 1_000,
          hardMaxSourceCharsPerChunk: 2_000,
        },
      },
      authToken: "secret-token",
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
      `<!doctype html><html><head><title>Docs</title></head><body><h2>Install</h2><p>Install the package</p><p>Run the setup</p><h2>Deploy</h2><p>Deploy the site</p><p>Check the output</p></body></html>`,
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

    const chunkContexts: Array<{
      taskId: string;
      headingText?: string;
      itemStart?: number;
      itemEnd?: number;
      itemIds: string[];
    }> = [];
    mockTranslateTaskWithOpenAi.mockImplementation(
      async (options: {
        task: {
          taskId: string;
          content: Array<{ id: string }>;
        };
        chunkContext?: {
          headingText?: string;
          itemStart: number;
          itemEnd: number;
        };
      }) => {
        chunkContexts.push({
          taskId: options.task.taskId,
          headingText: options.chunkContext?.headingText,
          itemStart: options.chunkContext?.itemStart,
          itemEnd: options.chunkContext?.itemEnd,
          itemIds: options.task.content.map((item) => item.id),
        });

        if (options.task.taskId === "task_dc3d488a4e__chunk_1") {
          return {
            rawText: JSON.stringify({
              schemaVersion: 2,
              taskId: options.task.taskId,
              translations: [
                { id: "1", translatedText: "安装" },
                { id: "2", translatedText: "安装该包" },
                { id: "3", translatedText: "运行安装步骤" },
              ],
            }),
            draft: {
              schemaVersion: 2 as const,
              taskId: options.task.taskId,
              translations: [
                { id: "1", translatedText: "安装" },
                { id: "2", translatedText: "安装该包" },
                { id: "3", translatedText: "运行安装步骤" },
              ],
            },
          };
        }

        return {
          rawText: JSON.stringify({
            schemaVersion: 2,
            taskId: options.task.taskId,
            translations: [
              { id: "4", translatedText: "部署" },
              { id: "5", translatedText: "部署站点" },
              { id: "6", translatedText: "检查输出" },
            ],
          }),
          draft: {
            schemaVersion: 2 as const,
            taskId: options.task.taskId,
            translations: [
              { id: "4", translatedText: "部署" },
              { id: "5", translatedText: "部署站点" },
              { id: "6", translatedText: "检查输出" },
            ],
          },
        };
      },
    );

    const summary = await runTranslations(repoDir, silentLogger);
    expect(summary.successCount).toBe(1);
    expect(mockTranslateTaskWithOpenAi).toHaveBeenCalledTimes(2);
    expect(chunkContexts).toEqual([
      {
        taskId: "task_dc3d488a4e__chunk_1",
        headingText: "Install",
        itemStart: 1,
        itemEnd: 3,
        itemIds: ["1", "2", "3"],
      },
      {
        taskId: "task_dc3d488a4e__chunk_2",
        headingText: "Deploy",
        itemStart: 4,
        itemEnd: 6,
        itemIds: ["4", "5", "6"],
      },
    ]);

    const result = JSON.parse(
      await readFile(
        join(repoDir, ".documirror", "tasks", "done", "task_dc3d488a4e.json"),
        "utf8",
      ),
    ) as {
      taskId: string;
      translations: Array<{ id: string; translatedText: string }>;
    };
    expect(result.taskId).toBe("task_dc3d488a4e");
    expect(result.translations).toEqual([
      { id: "1", translatedText: "安装" },
      { id: "2", translatedText: "安装该包" },
      { id: "3", translatedText: "运行安装步骤" },
      { id: "4", translatedText: "部署" },
      { id: "5", translatedText: "部署站点" },
      { id: "6", translatedText: "检查输出" },
    ]);
  });

  it("uses spare concurrency slots for chunks when fewer pages are active than the budget", async () => {
    const repoDir = await setupChunkedRunRepo({
      pageSlugs: ["index", "guide"],
      concurrency: 4,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    mockTranslateTaskWithOpenAi.mockImplementation(
      async (options: {
        task: {
          taskId: string;
          content: Array<{ id: string; text: string }>;
        };
      }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(20);
        inFlight -= 1;
        return buildDraftFromTask(options.task);
      },
    );

    const summary = await runTranslations(repoDir, silentLogger);

    expect(summary.successCount).toBe(2);
    expect(summary.failureCount).toBe(0);
    expect(maxInFlight).toBe(4);
  });

  it("keeps at most one in-flight chunk per page when page demand fills the concurrency budget", async () => {
    const repoDir = await setupChunkedRunRepo({
      pageSlugs: ["index", "guide", "api", "reference", "faq"],
      concurrency: 4,
    });

    let inFlight = 0;
    let maxInFlight = 0;
    const inFlightByPage = new Map<string, number>();
    const maxConcurrentByPage = new Map<string, number>();

    mockTranslateTaskWithOpenAi.mockImplementation(
      async (options: {
        task: {
          taskId: string;
          content: Array<{ id: string; text: string }>;
        };
      }) => {
        const pageTaskId = options.task.taskId.replace(/__chunk_\d+$/u, "");
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);

        const pageInFlight = (inFlightByPage.get(pageTaskId) ?? 0) + 1;
        inFlightByPage.set(pageTaskId, pageInFlight);
        maxConcurrentByPage.set(
          pageTaskId,
          Math.max(maxConcurrentByPage.get(pageTaskId) ?? 0, pageInFlight),
        );

        await delay(20);

        inFlight -= 1;
        const nextPageInFlight = (inFlightByPage.get(pageTaskId) ?? 1) - 1;
        if (nextPageInFlight === 0) {
          inFlightByPage.delete(pageTaskId);
        } else {
          inFlightByPage.set(pageTaskId, nextPageInFlight);
        }

        return buildDraftFromTask(options.task);
      },
    );

    const summary = await runTranslations(repoDir, silentLogger);

    expect(summary.successCount).toBe(5);
    expect(summary.failureCount).toBe(0);
    expect(maxInFlight).toBe(4);
    expect(
      [...maxConcurrentByPage.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, value]) => value),
    ).toEqual([1, 1, 1, 1, 1]);
  });

  it("writes one page-level run report with chunk details when parallel chunks fail", async () => {
    const repoDir = await setupChunkedRunRepo({
      pageSlugs: ["index"],
      concurrency: 4,
    });

    mockTranslateTaskWithOpenAi.mockImplementation(
      async (options: { task: { taskId: string } }) => {
        await delay(20);
        throw new Error(`simulated failure for ${options.task.taskId}`);
      },
    );

    const summary = await runTranslations(repoDir, silentLogger);
    expect(summary.successCount).toBe(0);
    expect(summary.failureCount).toBe(1);

    const [reportFile] = await readdir(
      join(repoDir, "reports", "translation-run"),
    );
    const report = JSON.parse(
      await readFile(
        join(repoDir, "reports", "translation-run", reportFile),
        "utf8",
      ),
    ) as {
      chunks?: Array<{ chunkId: string }>;
    };

    expect(
      report.chunks?.map((chunk) => chunk.chunkId.split("__chunk_")[1]),
    ).toEqual(["1", "2"]);
  });

  it("reorders inline code nodes during site build when translation changes the natural word order", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
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
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the new <code>anchor</code> prop on the <code>Menu</code> and <code>Popover</code> components.</p></body></html>`,
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

    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText:
              "在 `Menu` 和 `Popover` 组件上使用新的 `anchor` 属性。",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText:
              "在 `Menu` 和 `Popover` 组件上使用新的 `anchor` 属性。",
          },
        ],
      },
    });

    const runSummary = await runTranslations(repoDir, silentLogger);
    expect(runSummary.successCount).toBe(1);

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedFiles).toBe(1);

    const buildSummary = await buildMirror(repoDir, silentLogger, {
      profile: true,
    });
    expect(buildSummary.pageCount).toBe(1);
    expect(buildSummary.profile?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining([
        "load repository state",
        "prepare build state",
        "copy assets",
        "build pages",
      ]),
    );

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain(
      "<p>在 <code>Menu</code> 和 <code>Popover</code> 组件上使用新的 <code>anchor</code> 属性。</p>",
    );
  });

  it("injects runtime reconciliation fallback assets when enabled", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    const configPath = join(repoDir, ".documirror", "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      build: {
        runtimeReconciler?: {
          enabled?: boolean;
          scope?: string;
          strategy?: string;
        };
      };
    };
    config.build.runtimeReconciler = {
      enabled: true,
      strategy: "dom-only",
      scope: "body-and-attributes",
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    const snapshotPath = join(
      repoDir,
      ".documirror",
      "cache",
      "pages",
      "index.html",
    );
    await writeFile(
      snapshotPath,
      `<!doctype html><html><head><title>Docs</title><script>self.__next_f.push([1,"e:[[\\"$\\",\\"p\\",null,{\\"children\\":\\"Utilities for controlling background image position.\\"}]]\\n"])</script></head><body><main><p>Utilities for controlling background image position.</p></main></body></html>`,
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

    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "用于控制元素背景图位置的实用类。",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "用于控制元素背景图位置的实用类。",
          },
        ],
      },
    });

    const runSummary = await runTranslations(repoDir, silentLogger);
    expect(runSummary.successCount).toBe(1);

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedFiles).toBe(1);

    const buildSummary = await buildMirror(repoDir, silentLogger);
    expect(buildSummary.pageCount).toBe(1);
    expect(buildSummary.assetCount).toBe(1);

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    const runtimeAsset = await readFile(
      join(repoDir, "site", "_documirror", "runtime-reconciler.js"),
      "utf8",
    );

    expect(builtHtml).toContain(`<p>用于控制元素背景图位置的实用类。</p>`);
    expect(builtHtml).toContain(`id="__DOCUMIRROR_RECONCILER_DATA__"`);
    expect(builtHtml).toContain(
      `src="/_documirror/runtime-reconciler.js" data-documirror-runtime-reconciler="true"`,
    );
    expect(runtimeAsset).toContain(`MutationObserver`);
    expect(runtimeAsset).not.toContain(`__next_f`);
    expect(builtHtml).toContain(
      `\\"children\\":\\"Utilities for controlling background image position.\\"`,
    );
  });

  it("attaches partial build profile details when build fails", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

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
              snapshotPath: ".documirror/cache/pages/missing.html",
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

    const error = await buildMirror(repoDir, silentLogger, {
      profile: true,
    }).catch(
      (buildError) =>
        buildError as Error & {
          profile?: {
            steps: Array<{ label: string }>;
          };
        },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.profile?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining([
        "load repository state",
        "prepare build state",
        "copy assets",
        "build pages",
      ]),
    );
  });

  it("attaches partial apply profile details when apply fails late", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
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
    await planTranslations(repoDir);

    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
        ],
      },
    });

    const runSummary = await runTranslations(repoDir, silentLogger);
    expect(runSummary.successCount).toBe(1);

    const queuePath = join(repoDir, ".documirror", "tasks", "QUEUE.md");
    await rm(queuePath, { force: true });
    await mkdir(queuePath);

    const error = await applyTranslations(repoDir, silentLogger, {
      profile: true,
    }).catch(
      (applyError) =>
        applyError as Error & {
          profile?: {
            steps: Array<{ label: string }>;
          };
        },
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.profile?.steps.map((step) => step.label)).toEqual(
      expect.arrayContaining([
        "discover done results",
        "load and verify results",
        "apply translations and archive tasks",
        "write translations state",
        "sync task manifest",
      ]),
    );
  });

  it("retries only the failing chunk instead of rerunning the whole page", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: {
        ...createAiConfig(),
        maxAttemptsPerTask: 2,
        chunking: {
          enabled: true,
          strategy: "structural",
          maxItemsPerChunk: 3,
          softMaxSourceCharsPerChunk: 1_000,
          hardMaxSourceCharsPerChunk: 2_000,
        },
      },
      authToken: "secret-token",
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
      `<!doctype html><html><head><title>Docs</title></head><body><h2>Install</h2><p>Install the package</p><p>Run the setup</p><h2>Deploy</h2><p>Deploy the site</p><p>Check the output</p></body></html>`,
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

    mockTranslateTaskWithOpenAi.mockImplementation(
      async (options: {
        task: {
          taskId: string;
          content: Array<{ id: string }>;
        };
        previousResponse?: string;
      }) => {
        if (options.task.taskId === "task_dc3d488a4e__chunk_1") {
          return {
            rawText: JSON.stringify({
              schemaVersion: 2,
              taskId: options.task.taskId,
              translations: [
                { id: "1", translatedText: "安装" },
                { id: "2", translatedText: "安装该包" },
                { id: "3", translatedText: "运行安装步骤" },
              ],
            }),
            draft: {
              schemaVersion: 2 as const,
              taskId: options.task.taskId,
              translations: [
                { id: "1", translatedText: "安装" },
                { id: "2", translatedText: "安装该包" },
                { id: "3", translatedText: "运行安装步骤" },
              ],
            },
          };
        }

        if (!options.previousResponse) {
          return {
            rawText: JSON.stringify({
              schemaVersion: 2,
              taskId: options.task.taskId,
              translations: [
                { id: "4", translatedText: "部署" },
                { id: "5", translatedText: "部署站点" },
              ],
            }),
            draft: {
              schemaVersion: 2 as const,
              taskId: options.task.taskId,
              translations: [
                { id: "4", translatedText: "部署" },
                { id: "5", translatedText: "部署站点" },
              ],
            },
          };
        }

        return {
          rawText: JSON.stringify({
            schemaVersion: 2,
            taskId: options.task.taskId,
            translations: [
              { id: "4", translatedText: "部署" },
              { id: "5", translatedText: "部署站点" },
              { id: "6", translatedText: "检查输出" },
            ],
          }),
          draft: {
            schemaVersion: 2 as const,
            taskId: options.task.taskId,
            translations: [
              { id: "4", translatedText: "部署" },
              { id: "5", translatedText: "部署站点" },
              { id: "6", translatedText: "检查输出" },
            ],
          },
        };
      },
    );

    const summary = await runTranslations(repoDir, silentLogger);
    expect(summary.successCount).toBe(1);
    expect(mockTranslateTaskWithOpenAi).toHaveBeenCalledTimes(3);
    expect(
      mockTranslateTaskWithOpenAi.mock.calls.map(
        (call) => (call[0] as { task: { taskId: string } }).task.taskId,
      ),
    ).toEqual([
      "task_dc3d488a4e__chunk_1",
      "task_dc3d488a4e__chunk_2",
      "task_dc3d488a4e__chunk_2",
    ]);
    expect(
      mockTranslateTaskWithOpenAi.mock.calls.map((call) =>
        (
          call[0] as { task: { content: Array<{ id: string }> } }
        ).task.content.map((item) => item.id),
      ),
    ).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
      ["4", "5", "6"],
    ]);
    expect(
      (
        mockTranslateTaskWithOpenAi.mock.calls[2]?.[0] as {
          previousResponse?: string;
        }
      ).previousResponse,
    ).toContain('"translations"');
  });

  it("marks malformed done results invalid and verify reports schema errors", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
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
      `<!doctype html><html><head><title>Docs</title></head><body><p>Hello world</p></body></html>`,
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
    await writeFile(
      join(repoDir, ".documirror", "tasks", "done", "task_dc3d488a4e.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          taskId: "task_dc3d488a4e",
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

    const verifySummary = await verifyTranslationTask(
      repoDir,
      "task_dc3d488a4e",
    );
    expect(verifySummary.ok).toBe(false);
    expect(verifySummary.errorCount).toBeGreaterThan(0);

    const status = await getMirrorStatus(repoDir);
    expect(status.doneTaskCount).toBe(0);
    expect(status.invalidTaskCount).toBe(1);
  });

  it("preserves immutable applied history across repeated applies for the same page task", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    const snapshotPath = join(
      repoDir,
      ".documirror",
      "cache",
      "pages",
      "index.html",
    );
    const manifestPath = join(repoDir, ".documirror", "state", "manifest.json");
    await writeFile(
      manifestPath,
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

    await writeFile(
      snapshotPath,
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility together</p></body></html>`,
      "utf8",
    );
    await extractMirror(repoDir);
    await planTranslations(repoDir);
    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "一起使用 `snap-always` 工具",
          },
        ],
      },
    });
    await runTranslations(repoDir);
    await applyTranslations(repoDir);

    await writeFile(
      snapshotPath,
      `<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility again</p></body></html>`,
      "utf8",
    );
    await extractMirror(repoDir);
    await planTranslations(repoDir);
    mockTranslateTaskWithOpenAi.mockResolvedValueOnce({
      rawText: JSON.stringify({
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "再次使用 `snap-always` 工具",
          },
        ],
      }),
      draft: {
        schemaVersion: 2,
        taskId: "task_dc3d488a4e",
        translations: [
          {
            id: "1",
            translatedText: "再次使用 `snap-always` 工具",
          },
        ],
      },
    });
    await runTranslations(repoDir);
    await applyTranslations(repoDir);

    const historyEntries = await readdir(
      join(repoDir, ".documirror", "tasks", "applied", "history"),
    );
    const resultHistoryEntries = historyEntries.filter(
      (entry) =>
        entry.startsWith("task_dc3d488a4e--") &&
        entry.endsWith(".json") &&
        !entry.endsWith(".task.json") &&
        !entry.endsWith(".mapping.json"),
    );

    expect(resultHistoryEntries).toHaveLength(2);
    expect(
      await readFile(
        join(
          repoDir,
          ".documirror",
          "tasks",
          "applied",
          "task_dc3d488a4e.json",
        ),
        "utf8",
      ),
    ).toContain("再次使用 `snap-always` 工具");
  });
});
