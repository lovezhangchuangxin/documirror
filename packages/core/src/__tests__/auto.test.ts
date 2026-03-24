import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
  getMirrorStatus,
  initMirrorRepository,
  runAutoPipeline,
} from "@documirror/core";
import type { MirrorAiConfig, TranslationTaskFile } from "@documirror/shared";

import * as crawlModule from "../crawl";

const createdDirs: string[] = [];

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

describe("runAutoPipeline", () => {
  beforeEach(() => {
    mockTranslateTaskWithOpenAi.mockReset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("runs update, translate, apply, and build end to end", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-auto-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    mockSuccessfulCrawl(repoDir);
    mockTranslateTaskWithOpenAi.mockImplementation(
      async ({ task }: { task: TranslationTaskFile }) => ({
        rawText: JSON.stringify(createTranslatedDraft(task)),
        draft: createTranslatedDraft(task),
      }),
    );

    const summary = await runAutoPipeline(repoDir);
    expect(summary.ok).toBe(true);
    expect(summary.update.status).toBe("ok");
    expect(summary.run.status).toBe("ok");
    expect(summary.apply.status).toBe("ok");
    expect(summary.build.status).toBe("ok");
    expect(summary.run.summary?.successCount).toBe(1);

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain("一起使用 <code>snap-always</code> 工具");

    const status = await getMirrorStatus(repoDir);
    expect(status.pendingTaskCount).toBe(0);
    expect(status.appliedTaskCount).toBe(1);
  });

  it("continues apply and build when translate run has task failures", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-auto-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    mockSuccessfulCrawl(repoDir);
    mockTranslateTaskWithOpenAi.mockImplementation(
      async ({ task }: { task: TranslationTaskFile }) => ({
        rawText: JSON.stringify({
          schemaVersion: 2,
          taskId: task.taskId,
          translations: task.content.map((item) => ({
            id: item.id,
            translatedText:
              item.text === "Docs" ? "文档" : "一起使用 snap-always 工具",
          })),
        }),
        draft: {
          schemaVersion: 2,
          taskId: task.taskId,
          translations: task.content.map((item) => ({
            id: item.id,
            translatedText:
              item.text === "Docs" ? "文档" : "一起使用 snap-always 工具",
          })),
        },
      }),
    );

    const summary = await runAutoPipeline(repoDir);
    expect(summary.ok).toBe(false);
    expect(summary.run.status).toBe("partial");
    expect(summary.run.summary?.failureCount).toBe(1);
    expect(summary.apply.status).toBe("ok");
    expect(summary.apply.summary?.appliedFiles).toBe(0);
    expect(summary.build.status).toBe("ok");
    expect(summary.build.summary?.missingTranslations).toBeGreaterThan(0);

    const builtHtml = await readFile(
      join(repoDir, "site", "index.html"),
      "utf8",
    );
    expect(builtHtml).toContain(
      "Use the <code>snap-always</code> utility together",
    );
  });

  it("stops the pipeline when crawl produces no cached files", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-auto-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      ai: createAiConfig(),
      authToken: "secret-token",
    });

    vi.spyOn(crawlModule, "crawlMirror").mockResolvedValue({
      pageCount: 0,
      assetCount: 0,
      issueCount: 1,
      issues: [
        {
          kind: "robots",
          severity: "error",
          url: "https://docs.example.com",
          message: "blocked by robots.txt",
          discoveredFrom: null,
          attemptCount: 1,
          code: "ROBOTS_BLOCKED",
        },
      ],
      stats: {
        pageFailures: 1,
        assetFailures: 0,
        skippedByRobots: 1,
        invalidLinks: 0,
        robotsFailures: 0,
        retriedRequests: 0,
        timedOutRequests: 0,
      },
    });

    const summary = await runAutoPipeline(repoDir);
    expect(summary.ok).toBe(false);
    expect(summary.update.status).toBe("failed");
    expect(summary.update.error).toContain("Crawl produced no cached files");
    expect(summary.run.status).toBe("skipped");
    expect(summary.apply.status).toBe("skipped");
    expect(summary.build.status).toBe("skipped");
    expect(summary.blockingError).toEqual({
      stage: "update",
      message: expect.stringContaining("Crawl produced no cached files"),
    });
  });
});

function createTranslatedDraft(task: TranslationTaskFile) {
  return {
    schemaVersion: 2 as const,
    taskId: task.taskId,
    translations: task.content.map((item) => ({
      id: item.id,
      translatedText: translateTaskText(item.text),
    })),
  };
}

function translateTaskText(text: string): string {
  if (text === "Docs") {
    return "文档";
  }

  if (text.includes("`snap-always`")) {
    return "一起使用 `snap-always` 工具";
  }

  return `${text}（中）`;
}

function mockSuccessfulCrawl(repoDir: string): void {
  vi.spyOn(crawlModule, "crawlMirror").mockImplementation(async () => {
    const snapshotPath = join(
      repoDir,
      ".documirror",
      "cache",
      "pages",
      "index.html",
    );
    await writeFile(
      snapshotPath,
      "<!doctype html><html><head><title>Docs</title></head><body><p>Use the <code>snap-always</code> utility together</p></body></html>",
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

    return {
      pageCount: 1,
      assetCount: 0,
      issueCount: 0,
      issues: [],
      stats: {
        pageFailures: 0,
        assetFailures: 0,
        invalidLinks: 0,
        skippedByRobots: 0,
        retriedRequests: 0,
        timedOutRequests: 0,
        robotsFailures: 0,
      },
    };
  });
}
