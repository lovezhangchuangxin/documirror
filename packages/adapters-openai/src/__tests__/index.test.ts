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
      chunking: {
        enabled: true,
        strategy: "structural",
        maxItemsPerChunk: 80,
        softMaxSourceCharsPerChunk: 6_000,
        hardMaxSourceCharsPerChunk: 9_000,
      },
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

  it("adds protected-token guidance and retry context to the prompt", async () => {
    mockCreate.mockResolvedValueOnce(
      createChunkStream([
        '{"schemaVersion":2,"taskId":"task_test","translations":[',
        '{"id":"1","translatedText":"将 `snap-always` 用于 % i 个条目"}',
        "]}",
      ]),
    );

    await translateTaskWithOpenAi({
      ...createOptions(),
      task: {
        ...createOptions().task,
        content: [
          {
            id: "1",
            text: "Use `snap-always` for % i items",
            note: "Treat text wrapped in backticks as code literals, keep them unchanged in the same order, and do not move surrounding text across code boundaries.",
          },
        ],
      },
      previousResponse: JSON.stringify(
        {
          schemaVersion: 2,
          taskId: "task_test",
          translations: [
            {
              id: "1",
              translatedText: "将 snap-always 用于 %i 个条目",
            },
          ],
        },
        null,
        2,
      ),
      verificationIssues: [
        {
          code: "inline_code_mismatch",
          message:
            'Translation for id "1" must preserve inline code spans ["snap-always"] in the original order',
          jsonPath: "$.translations[0].translatedText",
        },
        {
          code: "placeholder_mismatch",
          message: 'Translation must preserve placeholders ["% i"] exactly',
          jsonPath: "$.translations[0].translatedText",
        },
      ],
    });

    const request = mockCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemPrompt = request.messages[0]?.content ?? "";
    const userPrompt = request.messages[1]?.content ?? "";

    expect(systemPrompt).toContain(
      "Preserve placeholders byte-for-byte, including spaces inside them.",
    );
    expect(systemPrompt).toContain(
      "Do not move words across inline code spans;",
    );
    expect(userPrompt).toContain("Protected item checklist");
    expect(userPrompt).toContain('"preserveInlineCodeSpans": [');
    expect(userPrompt).toContain('"snap-always"');
    expect(userPrompt).toContain('"preservePlaceholders": [');
    expect(userPrompt).toContain('"% i"');
    expect(userPrompt).toContain('"inlineCodeTextSlotLayout": [');
    expect(userPrompt).toContain(
      "Previous response that needs fixing. Use it as the base",
    );
    expect(userPrompt).toContain(
      "Items that failed verification and must be repaired:",
    );
    expect(userPrompt).toContain(
      '"currentTranslatedText": "将 snap-always 用于 %i 个条目"',
    );
    expect(userPrompt).toContain('"validationErrors": [');
    expect(userPrompt).toContain(
      'Translation for id \\"1\\" must preserve inline code spans [\\"snap-always\\"] in the original order',
    );
  });

  it("adds chunk context to the prompt for split page tasks", async () => {
    mockCreate.mockResolvedValueOnce(
      createChunkStream([
        '{"schemaVersion":2,"taskId":"task_test__chunk_1","translations":[',
        '{"id":"1","translatedText":"你好，世界"}',
        "]}",
      ]),
    );

    await translateTaskWithOpenAi({
      ...createOptions(),
      task: {
        ...createOptions().task,
        taskId: "task_test__chunk_1",
      },
      chunkContext: {
        chunkIndex: 1,
        chunkCount: 2,
        itemStart: 1,
        itemEnd: 40,
        headingText: "Install",
      },
    });

    const request = mockCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = request.messages[1]?.content ?? "";

    expect(userPrompt).toContain("Chunk context");
    expect(userPrompt).toContain('"chunkCount": 2');
    expect(userPrompt).toContain('"headingText": "Install"');
  });

  it("targets retry context by actual response items for id ordering issues", async () => {
    mockCreate.mockResolvedValueOnce(
      createChunkStream([
        '{"schemaVersion":2,"taskId":"task_test","translations":[',
        '{"id":"1","translatedText":"第一项"},',
        '{"id":"2","translatedText":"第二项 `snap-always`"}',
        "]}",
      ]),
    );

    await translateTaskWithOpenAi({
      ...createOptions(),
      task: {
        ...createOptions().task,
        content: [
          {
            id: "1",
            text: "First item",
          },
          {
            id: "2",
            text: "Second `snap-always` item",
            note: "Treat text wrapped in backticks as code literals, keep them unchanged in the same order, and do not move surrounding text across code boundaries.",
          },
        ],
      },
      previousResponse: JSON.stringify(
        {
          schemaVersion: 2,
          taskId: "task_test",
          translations: [
            {
              id: "2",
              translatedText: "第二项 `snap-always`",
            },
            {
              id: "2",
              translatedText: "重复第二项 `snap-always`",
            },
          ],
        },
        null,
        2,
      ),
      verificationIssues: [
        {
          code: "id_out_of_order",
          message:
            'Expected translation "1" at position 1 but found "2"; renumber items to match 1..2',
          jsonPath: "$.translations[0].id",
        },
        {
          code: "id_duplicate",
          message:
            'Duplicate translation "2" found; each id must appear exactly once',
          jsonPath: "$.translations[1].id",
        },
        {
          code: "id_missing",
          message:
            'Missing translation "1"; add the missing items so ids run strictly from 1 to 2',
          jsonPath: "$.translations",
        },
      ],
    });

    const request = mockCreate.mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const userPrompt = request.messages[1]?.content ?? "";

    expect(userPrompt).toContain('"responseIndex": 1');
    expect(userPrompt).toContain('"actualResponseId": "2"');
    expect(userPrompt).toContain('"expectedTaskIdAtPosition": "1"');
    expect(userPrompt).toContain('"sourceText": "Second `snap-always` item"');
    expect(userPrompt).toContain(
      '"expectedSourceTextAtPosition": "First item"',
    );
    expect(userPrompt).toContain(
      '"currentTranslatedText": "第二项 `snap-always`"',
    );
    expect(userPrompt).toContain('"missingTaskId": "1"');
    expect(userPrompt).toContain('"validationErrors": [');
  });
});
