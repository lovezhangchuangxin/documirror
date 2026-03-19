import fs from "fs-extra";
import { dirname, relative } from "pathe";

import type { JsonValue, Logger } from "@documirror/shared";

import { readJson, writeJson } from "./storage";

export async function writeScaffoldJsonIfMissing(
  path: string,
  value: JsonValue | object | unknown[],
  logger: Logger,
): Promise<void> {
  if (await fs.pathExists(path)) {
    logger.warn(
      `Skipped existing scaffold file: ${relative(process.cwd(), path)}`,
    );
    return;
  }

  await writeJson(path, value);
}

export async function writeOrMergeScaffoldJson(
  path: string,
  value: JsonValue | object | unknown[],
  logger: Logger,
): Promise<void> {
  if (!(await fs.pathExists(path))) {
    await writeJson(path, value);
    return;
  }

  const existing = await readJson<JsonValue | object | unknown[]>(path, {});
  const merged = mergeMissingValues(existing, value);
  await writeJson(path, merged);
  logger.info(
    `Merged missing scaffold fields into ${relative(process.cwd(), path)}`,
  );
}

export async function writeScaffoldTextIfMissing(
  path: string,
  value: string,
  logger: Logger,
): Promise<void> {
  if (await fs.pathExists(path)) {
    logger.warn(
      `Skipped existing scaffold file: ${relative(process.cwd(), path)}`,
    );
    return;
  }

  await fs.ensureDir(dirname(path));
  await fs.writeFile(path, value, "utf8");
}

function mergeMissingValues(
  existing: JsonValue | object | unknown[],
  scaffold: JsonValue | object | unknown[],
): JsonValue | object | unknown[] {
  if (Array.isArray(existing) || Array.isArray(scaffold)) {
    return existing;
  }

  if (isPlainObject(existing) && isPlainObject(scaffold)) {
    const merged: Record<string, unknown> = { ...existing };

    // Merge recursively so we can add missing scripts without touching user-defined ones.
    for (const [key, scaffoldValue] of Object.entries(scaffold)) {
      const existingValue = merged[key];
      if (existingValue === undefined) {
        merged[key] = scaffoldValue;
        continue;
      }

      if (isPlainObject(existingValue) && isPlainObject(scaffoldValue)) {
        merged[key] = mergeMissingValues(existingValue, scaffoldValue);
      }
    }

    return merged;
  }

  return existing;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
