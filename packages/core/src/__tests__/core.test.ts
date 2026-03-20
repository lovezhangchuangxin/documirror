import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  };
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
      "documirror translate run --repo .",
    );
    expect(mirrorPackage.scripts["documirror:config:ai"]).toBe(
      "documirror config ai --repo .",
    );
    expect(mirrorReadme).toContain("pnpm documirror:translate:run");
    expect(mirrorAgents).toContain(".env");
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

    const applySummary = await applyTranslations(repoDir);
    expect(applySummary.appliedFiles).toBe(1);
    expect(applySummary.appliedSegments).toBeGreaterThan(0);

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
