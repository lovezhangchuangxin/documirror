import { describe, expect, it } from "vitest";

import { normalizeCliArgv } from "../argv";

describe("normalizeCliArgv", () => {
  it("removes the pnpm argument separator before forwarded options", () => {
    expect(
      normalizeCliArgv(
        [
          "node",
          "documirror",
          "translate",
          "verify",
          "--repo",
          ".",
          "--",
          "--task",
          "412412",
        ],
        {
          stripForwardedOptionSeparator: true,
        },
      ),
    ).toEqual([
      "node",
      "documirror",
      "translate",
      "verify",
      "--repo",
      ".",
      "--task",
      "412412",
    ]);
  });

  it("preserves the cli separator for direct invocations", () => {
    expect(
      normalizeCliArgv([
        "node",
        "documirror",
        "translate",
        "verify",
        "--repo",
        ".",
        "--",
        "--task",
        "412412",
      ]),
    ).toEqual([
      "node",
      "documirror",
      "translate",
      "verify",
      "--repo",
      ".",
      "--",
      "--task",
      "412412",
    ]);
  });

  it("keeps separators before positional arguments even in script mode", () => {
    expect(
      normalizeCliArgv(
        [
          "node",
          "documirror",
          "init",
          "--locale",
          "zh-CN",
          "--",
          "-https://docs.example.com",
        ],
        {
          stripForwardedOptionSeparator: true,
        },
      ),
    ).toEqual([
      "node",
      "documirror",
      "init",
      "--locale",
      "zh-CN",
      "--",
      "-https://docs.example.com",
    ]);
  });

  it("leaves normal cli invocations unchanged", () => {
    expect(
      normalizeCliArgv([
        "node",
        "documirror",
        "translate",
        "claim",
        "--repo",
        ".",
        "--worker",
        "agent-01",
      ]),
    ).toEqual([
      "node",
      "documirror",
      "translate",
      "claim",
      "--repo",
      ".",
      "--worker",
      "agent-01",
    ]);
  });
});
