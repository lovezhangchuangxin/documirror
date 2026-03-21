import { describe, expect, it } from "vitest";

import { mirrorConfigSchema } from "../config";

describe("mirrorConfigSchema", () => {
  it("keeps runtime reconciler disabled by default", () => {
    const config = mirrorConfigSchema.parse({
      sourceUrl: "https://docs.example.com",
      targetLocale: "zh-CN",
      build: {
        basePath: "/",
      },
      ai: {
        baseUrl: "https://api.openai.com/v1",
        modelName: "gpt-4.1-mini",
      },
    });

    expect(config.build.runtimeReconciler.enabled).toBe(false);
  });
});
