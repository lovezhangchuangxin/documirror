import OpenAI from "openai";

import type {
  MirrorAiConfig,
  TranslationDraftResultFile,
  TranslationTaskFile,
  TranslationVerificationIssue,
} from "@documirror/shared";
import { translationDraftResultFileSchema } from "@documirror/shared";

export type OpenAiConnectionOptions = {
  config: MirrorAiConfig;
  authToken: string;
  signal?: AbortSignal;
  onDebug?: (message: string) => void;
};

export type OpenAiConnectionResult = {
  ok: boolean;
  message: string;
};

export type OpenAiTranslationOptions = OpenAiConnectionOptions & {
  task: TranslationTaskFile;
  previousResponse?: string;
  verificationIssues?: TranslationVerificationIssue[];
};

export type OpenAiTranslationResult = {
  rawText: string;
  draft: TranslationDraftResultFile;
};

export async function testOpenAiConnection(
  options: OpenAiConnectionOptions,
): Promise<OpenAiConnectionResult> {
  const { config, authToken, signal } = options;
  const client = createOpenAiClient(config, authToken);

  try {
    const response = await createChatCompletion(client, {
      config,
      signal,
      systemPrompt:
        'You are a connection test. Respond with valid JSON only: {"status":"ok"}.',
      userPrompt: "Return the exact JSON object now.",
    });
    if (!response.includes('"status"')) {
      return {
        ok: false,
        message: "The model responded, but not with the expected JSON payload.",
      };
    }

    return {
      ok: true,
      message: `Connected to ${config.llmProvider}/${config.modelName}`,
    };
  } catch (error) {
    return {
      ok: false,
      message: formatOpenAiError(error),
    };
  }
}

export async function translateTaskWithOpenAi(
  options: OpenAiTranslationOptions,
): Promise<OpenAiTranslationResult> {
  const {
    config,
    authToken,
    signal,
    task,
    previousResponse,
    verificationIssues = [],
    onDebug,
  } = options;
  const client = createOpenAiClient(config, authToken);
  const rawText = await createChatCompletion(client, {
    config,
    signal,
    onDebug,
    systemPrompt: createSystemPrompt(),
    userPrompt: createUserPrompt(task, previousResponse, verificationIssues),
  });

  const parsed = translationDraftResultFileSchema.parse(
    parseJsonResponse(rawText, onDebug),
  );
  return {
    rawText,
    draft: parsed,
  };
}

function createOpenAiClient(config: MirrorAiConfig, authToken: string): OpenAI {
  return new OpenAI({
    apiKey: authToken,
    baseURL: config.baseUrl,
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
  });
}

async function createChatCompletion(
  client: OpenAI,
  options: {
    config: MirrorAiConfig;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
  },
): Promise<string> {
  return requestChatCompletion(client, options, {
    useStream: true,
    useJsonMode: true,
  });
}

type ChatCompletionMode = {
  useStream: boolean;
  useJsonMode: boolean;
};

async function requestChatCompletion(
  client: OpenAI,
  options: {
    config: MirrorAiConfig;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
  },
  mode: ChatCompletionMode,
): Promise<string> {
  try {
    if (mode.useStream) {
      return await requestStreamingChatCompletion(client, options, mode);
    }

    return await requestNonStreamingChatCompletion(client, options, mode);
  } catch (error) {
    if (mode.useStream && looksLikeStreamingCompatibilityError(error)) {
      options.onDebug?.("provider rejected streaming; retrying without stream");
      return requestChatCompletion(client, options, {
        ...mode,
        useStream: false,
      });
    }

    if (mode.useJsonMode && looksLikeJsonModeCompatibilityError(error)) {
      options.onDebug?.(
        "provider rejected response_format=json_object; retrying without response_format",
      );
      return requestChatCompletion(client, options, {
        ...mode,
        useJsonMode: false,
      });
    }

    throw error;
  }
}

async function requestStreamingChatCompletion(
  client: OpenAI,
  options: {
    config: MirrorAiConfig;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
  },
  mode: ChatCompletionMode,
): Promise<string> {
  const { config, systemPrompt, userPrompt, signal, onDebug } = options;
  const requestStartedAt = Date.now();
  onDebug?.(
    mode.useJsonMode
      ? "sending streaming chat.completions request with response_format=json_object"
      : "sending streaming chat.completions request without response_format",
  );
  const stream = (await client.chat.completions.create(
    {
      model: config.modelName,
      temperature: config.temperature,
      stream: true,
      ...(mode.useJsonMode
        ? {
            response_format: {
              type: "json_object" as const,
            },
          }
        : {}),
      messages: createMessages(systemPrompt, userPrompt, mode.useJsonMode),
    },
    createRequestOptions(config, signal),
  )) as ChatCompletionStreamLike;

  let text = "";
  let chunkCount = 0;
  let receivedFirstContent = false;
  let lastProgressLogAt = requestStartedAt;

  for await (const chunk of stream) {
    chunkCount += 1;
    const deltaText = extractChatChunkText(chunk);
    if (!deltaText) {
      continue;
    }

    text += deltaText;
    if (!receivedFirstContent) {
      receivedFirstContent = true;
      onDebug?.(
        `received first streamed content after ${formatDuration(Date.now() - requestStartedAt)}`,
      );
    }

    if (Date.now() - lastProgressLogAt >= 5_000) {
      lastProgressLogAt = Date.now();
      onDebug?.(
        `streaming response in progress: ${text.length} chars across ${chunkCount} chunks`,
      );
    }
  }

  onDebug?.(
    `stream completed after ${formatDuration(Date.now() - requestStartedAt)} with ${text.length} chars across ${chunkCount} chunks`,
  );
  if (text.trim().length === 0) {
    throw new Error("The model returned an empty response.");
  }

  return text;
}

async function requestNonStreamingChatCompletion(
  client: OpenAI,
  options: {
    config: MirrorAiConfig;
    systemPrompt: string;
    userPrompt: string;
    signal?: AbortSignal;
    onDebug?: (message: string) => void;
  },
  mode: ChatCompletionMode,
): Promise<string> {
  const { config, systemPrompt, userPrompt, signal, onDebug } = options;
  onDebug?.(
    mode.useJsonMode
      ? "sending chat.completions request with response_format=json_object"
      : "sending chat.completions request without response_format",
  );
  const completion = await client.chat.completions.create(
    {
      model: config.modelName,
      temperature: config.temperature,
      stream: false,
      ...(mode.useJsonMode
        ? {
            response_format: {
              type: "json_object" as const,
            },
          }
        : {}),
      messages: createMessages(systemPrompt, userPrompt, mode.useJsonMode),
    },
    createRequestOptions(config, signal),
  );

  onDebug?.("received chat.completions response");
  return extractChatMessageText(completion as ChatCompletionLike);
}

function createMessages(
  systemPrompt: string,
  userPrompt: string,
  useJsonMode: boolean,
): Array<{
  role: "system" | "user";
  content: string;
}> {
  return [
    {
      role: "system",
      content: useJsonMode
        ? systemPrompt
        : `${systemPrompt}\n\nReturn valid JSON only.`,
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

function createRequestOptions(
  config: MirrorAiConfig,
  signal?: AbortSignal,
): {
  timeout: number;
  maxRetries: number;
  signal?: AbortSignal;
} {
  return {
    timeout: config.requestTimeoutMs,
    maxRetries: 0,
    signal,
  };
}

type ChatCompletionLike = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }> | null;
    };
  }>;
};

type ChatCompletionStreamLike = AsyncIterable<{
  choices?: Array<{
    delta?: {
      content?: string | Array<{ text?: string }> | null;
    };
  }>;
}>;

function extractChatMessageText(completion: ChatCompletionLike): string {
  const content = completion.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => ("text" in part ? part.text : ""))
      .join("")
      .trim();
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("The model returned an empty response.");
}

function parseJsonResponse(
  rawText: string,
  onDebug?: (message: string) => void,
): unknown {
  const sanitized = sanitizeModelResponse(rawText, onDebug);

  try {
    return JSON.parse(sanitized);
  } catch (error) {
    const extracted = extractLikelyJsonObject(sanitized);
    if (extracted && extracted !== sanitized) {
      onDebug?.("trimmed non-JSON wrapper text around the response payload");
      return JSON.parse(extracted);
    }

    throw error;
  }
}

function sanitizeModelResponse(
  rawText: string,
  onDebug?: (message: string) => void,
): string {
  let sanitized = rawText.replace(/^\uFEFF/u, "").trim();

  const thinkMatches = [
    ...sanitized.matchAll(/<think\b[^>]*>[\s\S]*?<\/think>/giu),
  ];
  if (thinkMatches.length > 0) {
    sanitized = sanitized
      .replace(/<think\b[^>]*>[\s\S]*?<\/think>/giu, "")
      .trim();
    onDebug?.(
      `removed ${thinkMatches.length} <think>...</think> block(s) before JSON parsing`,
    );
  }

  const fencedMatch = sanitized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  if (fencedMatch?.[1]) {
    sanitized = fencedMatch[1].trim();
    onDebug?.("removed markdown code fences around the JSON payload");
  }

  return sanitized;
}

function extractLikelyJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1).trim();
}

function extractChatChunkText(chunk: {
  choices?: Array<{
    delta?: {
      content?: string | Array<{ text?: string }> | null;
    };
  }>;
}): string {
  const content = chunk.choices?.[0]?.delta?.content;
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => ("text" in part ? (part.text ?? "") : ""))
      .join("");
  }

  return "";
}

function createSystemPrompt(): string {
  return [
    "You translate DocuMirror task files into the target locale.",
    "Return a JSON object only. Do not wrap it in markdown fences.",
    'The JSON must match this shape: {"schemaVersion":2,"taskId":"...","translations":[{"id":"1","translatedText":"..."}]}.',
    "Preserve ids exactly and keep them in the same order.",
    "Do not omit or add items.",
    "Preserve placeholders, markdown structure, list markers, HTML entities, and inline code in backticks.",
    "Do not translate inline code spans or placeholders.",
    "Apply glossary terms exactly when source terms appear.",
  ].join(" ");
}

function createUserPrompt(
  task: TranslationTaskFile,
  previousResponse?: string,
  verificationIssues: TranslationVerificationIssue[] = [],
): string {
  const parts = [
    `Translate the following DocuMirror task to ${task.targetLocale}.`,
    "Return a complete JSON result object.",
    "",
    "Task JSON:",
    JSON.stringify(task, null, 2),
  ];

  if (previousResponse) {
    parts.push("", "Previous response that needs fixing:", previousResponse);
  }

  if (verificationIssues.length > 0) {
    parts.push(
      "",
      "Fix these validation errors and return the full corrected JSON:",
      JSON.stringify(verificationIssues, null, 2),
    );
  }

  return parts.join("\n");
}

function looksLikeJsonModeCompatibilityError(error: unknown): boolean {
  const message = formatOpenAiError(error).toLowerCase();
  return (
    message.includes("response_format") ||
    message.includes("json_object") ||
    message.includes("unsupported")
  );
}

function looksLikeStreamingCompatibilityError(error: unknown): boolean {
  const message = formatOpenAiError(error).toLowerCase();
  return (
    message.includes("stream") &&
    (message.includes("unsupported") ||
      message.includes("not support") ||
      message.includes("invalid"))
  );
}

function formatOpenAiError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${totalSeconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
