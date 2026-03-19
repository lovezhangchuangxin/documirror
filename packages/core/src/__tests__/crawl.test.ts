import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { crawlWebsiteMock } = vi.hoisted(() => ({
  crawlWebsiteMock: vi.fn(),
}));

vi.mock("@documirror/crawler", () => ({
  crawlWebsite: crawlWebsiteMock,
}));

import { crawlMirror, initMirrorRepository } from "@documirror/core";

const createdDirs: string[] = [];

describe("crawlMirror", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes crawled pages and assets to disk while returning crawl issues", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-crawl-test-"));
    createdDirs.push(repoDir);

    await initMirrorRepository({
      repoDir,
      siteUrl: "https://docs.example.com/",
      targetLocale: "zh-CN",
    });

    crawlWebsiteMock.mockImplementation(
      async (
        _config: unknown,
        _logger: unknown,
        sink: {
          onPage?: (page: {
            url: string;
            canonicalUrl: string;
            status: number;
            contentType: string;
            outputPath: string;
            discoveredFrom: string | null;
            assetRefs: string[];
            html: string;
          }) => void | Promise<void>;
          onAsset?: (asset: {
            url: string;
            contentType: string;
            outputPath: string;
            buffer: Buffer;
          }) => void | Promise<void>;
        },
      ) => {
        const firstPageWrite = sink.onPage?.({
          url: "https://docs.example.com/",
          canonicalUrl: "https://docs.example.com/",
          status: 200,
          contentType: "text/html",
          outputPath: "index.html",
          discoveredFrom: null,
          assetRefs: ["https://docs.example.com/hero.png"],
          html: "<!doctype html><html><body><h1>Home</h1></body></html>",
        });
        expect(firstPageWrite).toBeDefined();

        const firstPageState = await Promise.race([
          Promise.resolve(firstPageWrite).then(() => "written"),
          Promise.resolve("pending"),
        ]);
        expect(firstPageState).toBe("pending");
        await firstPageWrite;

        await sink.onPage?.({
          url: "https://docs.example.com/guide",
          canonicalUrl: "https://docs.example.com/guide",
          status: 200,
          contentType: "text/html",
          outputPath: "guide/index.html",
          discoveredFrom: "https://docs.example.com/",
          assetRefs: [],
          html: "<!doctype html><html><body><h1>Guide</h1></body></html>",
        });
        const assetWrite = sink.onAsset?.({
          url: "https://docs.example.com/hero.png",
          contentType: "image/png",
          outputPath: "hero.png",
          buffer: Buffer.from("png"),
        });
        await assetWrite;

        return {
          pageCount: 2,
          assetCount: 1,
          issues: [
            {
              kind: "robots",
              severity: "warn",
              url: "https://docs.example.com/robots.txt",
              message:
                "Received 503 for robots.txt; continuing with allow-all rules",
              discoveredFrom: null,
              statusCode: 503,
              attemptCount: 3,
            },
            {
              kind: "invalid-link",
              severity: "warn",
              url: "https://docs.example.com/",
              message: 'Ignoring invalid a[href] value "http://["',
              discoveredFrom: null,
            },
          ],
          stats: {
            pageFailures: 0,
            assetFailures: 0,
            invalidLinks: 1,
            skippedByRobots: 0,
            retriedRequests: 2,
            timedOutRequests: 0,
            robotsFailures: 1,
          },
        };
      },
    );

    const summary = await crawlMirror(repoDir);

    expect(summary.pageCount).toBe(2);
    expect(summary.assetCount).toBe(1);
    expect(summary.stats.invalidLinks).toBe(1);
    expect(summary.stats.robotsFailures).toBe(1);

    const manifest = JSON.parse(
      await readFile(
        join(repoDir, ".documirror", "state", "manifest.json"),
        "utf8",
      ),
    ) as {
      pages: Record<string, { snapshotPath: string }>;
      assets: Record<string, { cachePath: string }>;
    };

    expect(Object.keys(manifest.pages)).toHaveLength(2);
    expect(Object.keys(manifest.assets)).toHaveLength(1);

    const snapshotPath = join(
      repoDir,
      manifest.pages["https://docs.example.com/"].snapshotPath,
    );
    const assetPath = join(
      repoDir,
      manifest.assets["https://docs.example.com/hero.png"].cachePath,
    );

    expect(await readFile(snapshotPath, "utf8")).toContain("Home");
    expect(await readFile(assetPath)).toEqual(Buffer.from("png"));
  });
});
