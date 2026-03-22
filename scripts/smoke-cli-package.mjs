import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const artifactsDir = resolve(".artifacts");
const tarballs = (await readdir(artifactsDir))
  .filter((name) => name.startsWith("documirror-cli-") && name.endsWith(".tgz"))
  .sort();

if (tarballs.length !== 1) {
  throw new Error(
    `Expected exactly one CLI tarball in ${artifactsDir}, found ${tarballs.length}.`,
  );
}

const tarballPath = join(artifactsDir, tarballs[0]);
const installDir = await mkdtemp(join(tmpdir(), "documirror-cli-smoke-"));
const storeDir = join(installDir, ".pnpm-store");
const binPath = join(
  installDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "documirror.cmd" : "documirror",
);

try {
  await execFileAsync(
    "pnpm",
    [
      "add",
      tarballPath,
      "--dir",
      installDir,
      "--store-dir",
      storeDir,
      "--config.node-linker=hoisted",
    ],
    {
      env: {
        ...process.env,
        CI: "1",
      },
    },
  );

  await execFileAsync(binPath, ["--help"], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });

  await execFileAsync(binPath, ["translate", "run", "--help"], {
    env: {
      ...process.env,
      FORCE_COLOR: "0",
    },
  });
} finally {
  await rm(installDir, { recursive: true, force: true });
}
