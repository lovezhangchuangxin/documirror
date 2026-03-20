import { describe, expect, it } from "vitest";

import {
  extractPlaceholderTokens,
  parseInlineCodeSpans,
  replacePlaceholderTokens,
} from "../text";

describe("text utils", () => {
  it("extracts placeholders with exact spacing", () => {
    expect(
      extractPlaceholderTokens("Use % i, {name}, {{ value }}, and <0> now."),
    ).toEqual(["% i", "{name}", "{{ value }}", "<0>"]);
  });

  it("replaces placeholders without changing surrounding text", () => {
    expect(replacePlaceholderTokens("Hello {name}, value=% i", " ")).toBe(
      "Hello  , value= ",
    );
  });

  it("parses inline code spans into text slots", () => {
    expect(
      parseInlineCodeSpans("Use `snap-always` with `npm install`"),
    ).toEqual({
      textSegments: ["Use ", " with ", ""],
      inlineCodeSpans: ["snap-always", "npm install"],
    });
  });
});
