import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCreate, mockOpenAI } = vi.hoisted(() => {
  const create = vi.fn();
  const openAI = vi.fn(function MockOpenAI() {
    return {
      chat: {
        completions: {
          create,
        },
      },
    };
  });

  return {
    mockCreate: create,
    mockOpenAI: openAI,
  };
});

vi.mock("openai", () => ({
  default: mockOpenAI,
}));

import {
  translateTaskWithOpenAi,
  type OpenAiTranslationOptions,
} from "../index";

function createOptions(): OpenAiTranslationOptions {
  return {
    config: {
      providerKind: "openai-compatible",
      llmProvider: "openai",
      baseUrl: "https://api.openai.com/v1",
      modelName: "gpt-4.1-mini",
      authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
      concurrency: 2,
      requestTimeoutMs: 300_000,
      maxAttemptsPerTask: 3,
      temperature: 0.2,
    },
    authToken: "secret-token",
    task: {
      schemaVersion: 2,
      taskId: "task_test",
      sourceUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      createdAt: "2026-03-20T00:00:00.000Z",
      instructions: {
        translateTo: "zh-CN",
        preserveFormatting: true,
        preservePlaceholders: true,
        preserveInlineCode: true,
        applyGlossary: true,
        noOmission: true,
        noAddition: true,
      },
      glossary: [],
      page: {
        url: "https://docs.example.com/page",
        title: "Docs",
      },
      content: [
        {
          id: "1",
          text: "Hello world",
        },
      ],
    },
  };
}

async function* createChunkStream(chunks: string[]) {
  for (const chunk of chunks) {
    yield {
      choices: [
        {
          delta: {
            content: chunk,
          },
        },
      ],
    };
  }
}

describe("adapters-openai", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockOpenAI.mockClear();
  });

  it("uses streaming responses and aggregates chunk text", async () => {
    mockCreate.mockResolvedValueOnce(
      createChunkStream([
        '{"schemaVersion":2,"taskId":"task_test","translations":[',
        '{"id":"1","translatedText":"你好，世界"}',
        "]}",
      ]),
    );
    const debugMessages: string[] = [];

    const result = await translateTaskWithOpenAi({
      ...createOptions(),
      onDebug(message) {
        debugMessages.push(message);
      },
    });

    expect(result.draft.translations[0]?.translatedText).toBe("你好，世界");
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
      response_format: {
        type: "json_object",
      },
    });
    expect(mockOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "secret-token",
        baseURL: "https://api.openai.com/v1",
        timeout: 300_000,
        maxRetries: 0,
      }),
    );
    expect(debugMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "sending streaming chat.completions request with response_format=json_object",
        ),
        expect.stringContaining("received first streamed content"),
        expect.stringContaining("stream completed"),
      ]),
    );
  });

  it("falls back to non-streaming when the provider rejects stream mode", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("stream is unsupported"))
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content:
                '{"schemaVersion":2,"taskId":"task_test","translations":[{"id":"1","translatedText":"你好"}]}',
            },
          },
        ],
      });
    const debugMessages: string[] = [];

    const result = await translateTaskWithOpenAi({
      ...createOptions(),
      onDebug(message) {
        debugMessages.push(message);
      },
    });

    expect(result.draft.translations[0]?.translatedText).toBe("你好");
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      stream: true,
    });
    expect(mockCreate.mock.calls[1]?.[0]).toMatchObject({
      stream: false,
      response_format: {
        type: "json_object",
      },
    });
    expect(debugMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "provider rejected streaming; retrying without stream",
        ),
        expect.stringContaining(
          "sending chat.completions request with response_format=json_object",
        ),
      ]),
    );
  });

  it("strips think blocks before parsing streamed JSON output", async () => {
    mockCreate.mockResolvedValueOnce(
      createChunkStream([
        "<think>\nI should reason privately first.\n</think>\n",
        '{"schemaVersion":2,"taskId":"task_test","translations":[',
        '{"id":"1","translatedText":"你好，世界"}',
        "]}",
      ]),
    );
    const debugMessages: string[] = [];

    const result = await translateTaskWithOpenAi({
      ...createOptions(),
      onDebug(message) {
        debugMessages.push(message);
      },
    });

    expect(result.draft.translations[0]?.translatedText).toBe("你好，世界");
    expect(debugMessages).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "removed 1 <think>...</think> block(s) before JSON parsing",
        ),
      ]),
    );
  });
});
