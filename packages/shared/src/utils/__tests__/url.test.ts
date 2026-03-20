import { describe, expect, it } from "vitest";

import { urlToAssetOutputPath, urlToOutputPath } from "../url";

describe("url output paths", () => {
  it("keeps query variants on distinct page output paths", () => {
    const firstPath = urlToOutputPath("https://docs.example.com/guide?lang=en");
    const secondPath = urlToOutputPath(
      "https://docs.example.com/guide?lang=zh",
    );

    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toMatch(/^guide\/index__q_[a-f0-9]{12}\.html$/);
    expect(secondPath).toMatch(/^guide\/index__q_[a-f0-9]{12}\.html$/);
  });

  it("keeps query variants on distinct asset output paths", () => {
    const firstPath = urlToAssetOutputPath(
      "https://docs.example.com/assets/app.css?v=1",
    );
    const secondPath = urlToAssetOutputPath(
      "https://docs.example.com/assets/app.css?v=2",
    );

    expect(firstPath).not.toBe(secondPath);
    expect(firstPath).toMatch(/^assets\/app__q_[a-f0-9]{12}\.css$/);
    expect(secondPath).toMatch(/^assets\/app__q_[a-f0-9]{12}\.css$/);
  });
});
