import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger, MirrorConfig } from "@documirror/shared";

const { axiosGetMock } = vi.hoisted(() => ({
  axiosGetMock: vi.fn(),
}));

vi.mock("axios", () => ({
  default: {
    get: axiosGetMock,
    isAxiosError: (error: unknown) =>
      Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
  },
}));

import { crawlWebsite } from "../crawl-website";

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};

afterEach(() => {
  axiosGetMock.mockReset();
});

describe("crawlWebsite", () => {
  it("caps total HTTP concurrency with a single queue", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;

    axiosGetMock.mockImplementation(async (url: string) => {
      switch (url) {
        case "https://docs.example.com/robots.txt":
          return textResponse("User-agent: *\nAllow: /\n");
        case "https://docs.example.com/":
          return htmlResponse(
            `<!doctype html><html><body><a href="/guide">Guide</a><a href="/api">API</a><img src="/hero.png"></body></html>`,
          );
        case "https://docs.example.com/guide":
        case "https://docs.example.com/api":
        case "https://docs.example.com/hero.png":
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          await wait(20);
          activeRequests -= 1;
          return url.endsWith(".png")
            ? assetResponse()
            : htmlResponse(
                `<!doctype html><html><body><h1>${url}</h1></body></html>`,
              );
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const result = await crawlWebsite(
      createConfig("https://docs.example.com/", 2),
      silentLogger,
    );

    expect(result.pageCount).toBe(3);
    expect(result.assetCount).toBe(1);
    expect(result.issues).toHaveLength(0);
    expect(maxActiveRequests).toBeLessThanOrEqual(2);
  });

  it("retries timeout failures and records invalid links without failing the crawl", async () => {
    let assetAttempts = 0;

    axiosGetMock.mockImplementation(async (url: string) => {
      switch (url) {
        case "https://docs.example.com/robots.txt":
          return textResponse("User-agent: *\nAllow: /\n");
        case "https://docs.example.com/":
          return htmlResponse(
            `<!doctype html><html><body><a href="http://[">Broken</a><img src="/slow.png"></body></html>`,
          );
        case "https://docs.example.com/slow.png":
          assetAttempts += 1;
          if (assetAttempts === 1) {
            throw createAxiosError("timeout of 20ms exceeded", "ECONNABORTED");
          }

          return assetResponse();
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const result = await crawlWebsite(
      createConfig("https://docs.example.com/", 2, {
        requestTimeoutMs: 20,
        requestRetryCount: 1,
        requestRetryDelayMs: 0,
      }),
      silentLogger,
    );

    expect(result.pageCount).toBe(1);
    expect(result.assetCount).toBe(1);
    expect(result.stats.invalidLinks).toBe(1);
    expect(result.stats.timedOutRequests).toBe(1);
    expect(result.stats.retriedRequests).toBe(1);
    expect(result.stats.assetFailures).toBe(0);
    expect(result.issues.some((issue) => issue.kind === "invalid-link")).toBe(
      true,
    );
    expect(assetAttempts).toBe(2);
  });

  it("reports robots.txt fallback issues instead of failing silently", async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      switch (url) {
        case "https://docs.example.com/robots.txt":
          return textResponse("temporary failure", 503);
        case "https://docs.example.com/":
          return htmlResponse(
            `<!doctype html><html><body><h1>Home</h1></body></html>`,
          );
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const result = await crawlWebsite(
      createConfig("https://docs.example.com/", 2),
      silentLogger,
    );

    expect(result.pageCount).toBe(1);
    expect(result.stats.robotsFailures).toBe(1);
    expect(result.issues[0]?.kind).toBe("robots");
    expect(result.stats.retriedRequests).toBe(2);
  });

  it("treats pages without a content-type header as html", async () => {
    axiosGetMock.mockImplementation(async (url: string) => {
      switch (url) {
        case "https://docs.example.com/robots.txt":
          return textResponse("User-agent: *\nAllow: /\n");
        case "https://docs.example.com/":
          return {
            data: Buffer.from(
              `<!doctype html><html><body><a href="/guide">Guide</a></body></html>`,
            ),
            status: 200,
            headers: {},
          };
        case "https://docs.example.com/guide":
          return htmlResponse(
            `<!doctype html><html><body><h1>Guide</h1></body></html>`,
          );
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const result = await crawlWebsite(
      createConfig("https://docs.example.com/", 2),
      silentLogger,
    );

    expect(result.pageCount).toBe(2);
    expect(result.assetCount).toBe(0);
  });

  it("reports live page and asset counts while crawling", async () => {
    const onProgress = vi.fn();

    axiosGetMock.mockImplementation(async (url: string) => {
      switch (url) {
        case "https://docs.example.com/robots.txt":
          return textResponse("User-agent: *\nAllow: /\n");
        case "https://docs.example.com/":
          return htmlResponse(
            `<!doctype html><html><body><a href="/guide">Guide</a><img src="/hero.png"></body></html>`,
          );
        case "https://docs.example.com/guide":
          return htmlResponse(
            `<!doctype html><html><body><h1>Guide</h1></body></html>`,
          );
        case "https://docs.example.com/hero.png":
          return assetResponse();
        default:
          throw new Error(`Unexpected URL: ${url}`);
      }
    });

    const result = await crawlWebsite(
      createConfig("https://docs.example.com/", 1),
      silentLogger,
      {
        onProgress,
      },
    );

    expect(result.pageCount).toBe(2);
    expect(result.assetCount).toBe(1);
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      {
        kind: "start",
        pageCount: 0,
        assetCount: 0,
      },
      {
        kind: "page",
        pageCount: 1,
        assetCount: 0,
        url: "https://docs.example.com/",
      },
      {
        kind: "asset",
        pageCount: 1,
        assetCount: 1,
        url: "https://docs.example.com/hero.png",
      },
      {
        kind: "page",
        pageCount: 2,
        assetCount: 1,
        url: "https://docs.example.com/guide",
      },
    ]);
  });

  it("aborts in-flight requests when the crawl signal is cancelled", async () => {
    let resolvePageRequestStarted: (() => void) | undefined;
    const pageRequestStarted = new Promise<void>((resolve) => {
      resolvePageRequestStarted = resolve;
    });

    axiosGetMock.mockImplementation(
      async (url: string, options?: { signal?: AbortSignal }) => {
        switch (url) {
          case "https://docs.example.com/robots.txt":
            return textResponse("User-agent: *\nAllow: /\n");
          case "https://docs.example.com/":
            return new Promise((_resolve, reject) => {
              resolvePageRequestStarted?.();
              options?.signal?.addEventListener(
                "abort",
                () => {
                  reject(createAxiosError("canceled", "ERR_CANCELED"));
                },
                { once: true },
              );
            });
          default:
            throw new Error(`Unexpected URL: ${url}`);
        }
      },
    );

    const controller = new AbortController();
    const crawlPromise = crawlWebsite(
      createConfig("https://docs.example.com/", 1),
      silentLogger,
      {
        signal: controller.signal,
      },
    );

    await pageRequestStarted;
    controller.abort(
      new Error("Interrupted by Ctrl+C; crawling source site cancelled"),
    );

    await expect(crawlPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Interrupted by Ctrl+C; crawling source site cancelled",
    });
  });
});

function createConfig(
  siteUrl: string,
  crawlConcurrency: number,
  overrides: Partial<MirrorConfig> = {},
): MirrorConfig {
  return {
    sourceUrl: siteUrl,
    targetLocale: "zh-CN",
    entryUrls: [siteUrl],
    includePatterns: [],
    excludePatterns: [],
    crawlConcurrency,
    requestTimeoutMs: 1_000,
    requestRetryCount: 2,
    requestRetryDelayMs: 10,
    requestHeaders: {},
    selectors: {
      include: [],
      exclude: [],
    },
    attributeRules: {
      translate: ["title", "alt", "aria-label", "placeholder"],
      ignore: [],
    },
    build: {
      basePath: "/",
    },
    ai: {
      providerKind: "openai-compatible",
      llmProvider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
      authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
      concurrency: 4,
      requestTimeoutMs: 60_000,
      maxAttemptsPerTask: 3,
      temperature: 0.2,
      chunking: {
        enabled: true,
        strategy: "structural",
        maxItemsPerChunk: 80,
        softMaxSourceCharsPerChunk: 6_000,
        hardMaxSourceCharsPerChunk: 9_000,
      },
    },
    ...overrides,
  };
}

function textResponse(data: string, status = 200) {
  return {
    data,
    status,
    headers: {
      "content-type": "text/plain",
    },
  };
}

function htmlResponse(data: string, status = 200) {
  return {
    data: Buffer.from(data),
    status,
    headers: {
      "content-type": "text/html",
    },
  };
}

function assetResponse(status = 200) {
  return {
    data: Buffer.from("png"),
    status,
    headers: {
      "content-type": "image/png",
    },
  };
}

function createAxiosError(message: string, code: string) {
  return Object.assign(new Error(message), {
    code,
    isAxiosError: true,
  });
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
