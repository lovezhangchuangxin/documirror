import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadEnvFile,
  resolveAiAuthToken,
  upsertEnvVar,
} from "@documirror/core";
import type { MirrorAiConfig } from "@documirror/shared";

const createdDirs: string[] = [];

function createAiConfig(): MirrorAiConfig {
  return {
    providerKind: "openai-compatible",
    llmProvider: "openai",
    baseUrl: "https://api.openai.com/v1",
    modelName: "gpt-4.1-mini",
    authTokenEnvVar: "DOCUMIRROR_AI_AUTH_TOKEN",
    concurrency: 4,
    requestTimeoutMs: 60_000,
    maxAttemptsPerTask: 3,
    temperature: 0.2,
  };
}

describe("ai-config helpers", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(
      createdDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("updates one env var without destroying comments or unrelated variables", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-ai-config-"));
    createdDirs.push(repoDir);
    const envPath = join(repoDir, ".env");

    await writeFile(
      envPath,
      [
        "# shared variables",
        "export DOCUMIRROR_AI_AUTH_TOKEN=old-token",
        "",
        "OTHER_VAR=keep-me",
        "# keep this comment",
        "",
      ].join("\n"),
      "utf8",
    );

    await upsertEnvVar(envPath, "DOCUMIRROR_AI_AUTH_TOKEN", "new token");

    const body = await readFile(envPath, "utf8");
    expect(body).toContain("# shared variables");
    expect(body).toContain('export DOCUMIRROR_AI_AUTH_TOKEN="new token"');
    expect(body).toContain("OTHER_VAR=keep-me");
    expect(body).toContain("# keep this comment");
  });

  it("reads auth tokens from .env entries with export syntax", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-ai-config-"));
    createdDirs.push(repoDir);
    const envPath = join(repoDir, ".env");

    await writeFile(
      envPath,
      'export DOCUMIRROR_AI_AUTH_TOKEN="secret-token" # inline comment\n',
      "utf8",
    );

    const env = await loadEnvFile(envPath);
    const token = await resolveAiAuthToken(repoDir, createAiConfig());

    expect(env.DOCUMIRROR_AI_AUTH_TOKEN).toBe("secret-token");
    expect(token).toBe("secret-token");
  });

  it("prefers the repo .env token over the process environment", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "documirror-ai-config-"));
    createdDirs.push(repoDir);
    const envPath = join(repoDir, ".env");
    const previous = process.env.DOCUMIRROR_AI_AUTH_TOKEN;

    await writeFile(envPath, "DOCUMIRROR_AI_AUTH_TOKEN=file-token\n", "utf8");
    process.env.DOCUMIRROR_AI_AUTH_TOKEN = "process-token";

    try {
      const token = await resolveAiAuthToken(repoDir, createAiConfig());
      expect(token).toBe("file-token");
    } finally {
      if (previous === undefined) {
        delete process.env.DOCUMIRROR_AI_AUTH_TOKEN;
      } else {
        process.env.DOCUMIRROR_AI_AUTH_TOKEN = previous;
      }
    }
  });
});
