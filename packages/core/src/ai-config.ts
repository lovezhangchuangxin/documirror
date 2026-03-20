import fs from "fs-extra";
import { join } from "pathe";

import { testOpenAiConnection } from "@documirror/adapters-openai";
import type { Logger, MirrorAiConfig, MirrorConfig } from "@documirror/shared";
import { defaultLogger, mirrorConfigSchema } from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import { readJson, writeJson } from "./storage";

export async function saveMirrorAiConfig(
  repoDir: string,
  ai: MirrorAiConfig,
  authToken: string,
  logger: Logger = defaultLogger,
): Promise<void> {
  const paths = getRepoPaths(repoDir);
  const existing = await readJson<Partial<MirrorConfig>>(paths.configPath, {});
  const nextConfig = mirrorConfigSchema.parse({
    ...existing,
    ai,
  });

  await writeJson(paths.configPath, nextConfig);
  await upsertEnvVar(paths.envPath, ai.authTokenEnvVar, authToken);
  await ensureGitIgnoreEntry(paths.gitIgnorePath, ".env");
  logger.info(`Updated AI configuration in ${repoDir}`);
}

export async function testAiConnection(
  ai: MirrorAiConfig,
  authToken: string,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  message: string;
}> {
  return testOpenAiConnection({
    config: ai,
    authToken,
    signal,
  });
}

export async function resolveAiAuthToken(
  repoDir: string,
  ai: MirrorAiConfig,
): Promise<string> {
  const env = await loadEnvFile(join(repoDir, ".env"));
  const envFromFile = env[ai.authTokenEnvVar]?.trim();
  if (envFromFile) {
    return envFromFile;
  }

  const envFromProcess = process.env[ai.authTokenEnvVar]?.trim();
  if (envFromProcess) {
    return envFromProcess;
  }

  throw new Error(
    `Missing AI auth token. Set ${ai.authTokenEnvVar} in ${join(repoDir, ".env")}.`,
  );
}

export async function loadEnvFile(
  path: string,
): Promise<Record<string, string>> {
  if (!(await fs.pathExists(path))) {
    return {};
  }

  const body = await fs.readFile(path, "utf8");
  return parseDotEnv(body);
}

export async function upsertEnvVar(
  path: string,
  key: string,
  value: string,
): Promise<void> {
  const serializedValue = quoteIfNeeded(value);
  if (!(await fs.pathExists(path))) {
    await fs.writeFile(path, `${key}=${serializedValue}\n`, "utf8");
    return;
  }

  const body = await fs.readFile(path, "utf8");
  const lines = body.split(/\r?\n/u);
  const nextLines: string[] = [];
  let updated = false;

  lines.forEach((line) => {
    const parsed = parseDotEnvAssignment(line);
    if (!parsed || parsed.key !== key) {
      nextLines.push(line);
      return;
    }

    if (updated) {
      return;
    }

    nextLines.push(
      `${parsed.leadingWhitespace}${parsed.exportPrefix}${key}=${serializedValue}`,
    );
    updated = true;
  });

  if (!updated) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push(`${key}=${serializedValue}`);
    } else {
      nextLines.splice(nextLines.length - 1, 0, `${key}=${serializedValue}`);
    }
  }

  const nextBody = ensureTrailingNewline(nextLines.join("\n"));
  await fs.writeFile(path, nextBody, "utf8");
}

export async function writeEnvTemplateIfMissing(
  path: string,
  key: string,
  logger: Logger,
): Promise<void> {
  if (await fs.pathExists(path)) {
    logger.warn(`Skipped existing scaffold file: ${path}`);
    return;
  }

  await fs.writeFile(path, `# DocuMirror AI credentials\n${key}=\n`, "utf8");
}

export async function ensureGitIgnoreEntry(
  path: string,
  entry: string,
): Promise<void> {
  const existing = (await fs.pathExists(path))
    ? await fs.readFile(path, "utf8")
    : "";
  const lines = existing
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.includes(entry)) {
    return;
  }

  const next =
    existing.endsWith("\n") || existing.length === 0
      ? `${existing}${entry}\n`
      : `${existing}\n${entry}\n`;
  await fs.writeFile(path, next, "utf8");
}

function parseDotEnv(body: string): Record<string, string> {
  const values: Record<string, string> = {};

  body.split(/\r?\n/u).forEach((line) => {
    const parsed = parseDotEnvAssignment(line);
    if (!parsed) {
      return;
    }

    values[parsed.key] = parseDotEnvValue(parsed.rawValue);
  });

  return values;
}

function parseDotEnvAssignment(line: string): {
  key: string;
  rawValue: string;
  exportPrefix: string;
  leadingWhitespace: string;
} | null {
  const match = line.match(
    /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u,
  );
  if (!match) {
    return null;
  }

  return {
    leadingWhitespace: match[1] ?? "",
    exportPrefix: match[2] ?? "",
    key: match[3] ?? "",
    rawValue: match[4] ?? "",
  };
}

function parseDotEnvValue(value: string): string {
  const trimmed = value.trim();
  const quoted = parseQuotedDotEnvValue(trimmed);
  if (quoted !== null) {
    return quoted;
  }

  const commentStart = trimmed.search(/\s+#/u);
  const withoutComment =
    commentStart >= 0 ? trimmed.slice(0, commentStart) : trimmed;
  return withoutComment.trim();
}

function quoteIfNeeded(value: string): string {
  return /[\s#]/u.test(value) ? JSON.stringify(value) : value;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function parseQuotedDotEnvValue(value: string): string | null {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    return null;
  }

  for (let index = 1; index < value.length; index += 1) {
    if (value[index] !== quote) {
      continue;
    }

    if (quote === '"' && value[index - 1] === "\\") {
      continue;
    }

    return value.slice(1, index);
  }

  return null;
}
