import { describe, expect, it } from "vitest";

import type { TranslationTaskMappingEntry } from "@documirror/shared";

import { buildInlineGroupPlan } from "../domain/inline-groups";

describe("inline group planning", () => {
  it("projects translated text across grouped segments", () => {
    const mappedItem: Extract<
      TranslationTaskMappingEntry,
      { kind: "inline-code" }
    > = {
      id: "1",
      kind: "inline-code",
      segments: [
        { segmentId: "seg-1", sourceHash: "hash-1" },
        { segmentId: "seg-2", sourceHash: "hash-2" },
      ],
      inlineCodeSpans: [
        { text: "foo", domPath: "body.p.code[1]" },
        { text: "bar", domPath: "body.p.code[2]" },
      ],
      textSlotIndices: [0, 1],
    };

    const result = buildInlineGroupPlan(mappedItem, "先 `foo` 后 `bar`");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.projectedSegmentTexts).toEqual(["先 ", " 后 "]);
    expect(result.plan.parts).toEqual([
      { kind: "text", translatedText: "先 " },
      { kind: "code", text: "foo", domPath: "body.p.code[1]" },
      { kind: "text", translatedText: " 后 " },
      { kind: "code", text: "bar", domPath: "body.p.code[2]" },
    ]);
  });

  it("fails when translated inline code spans no longer match", () => {
    const mappedItem: Extract<
      TranslationTaskMappingEntry,
      { kind: "inline-code" }
    > = {
      id: "1",
      kind: "inline-code",
      segments: [{ segmentId: "seg-1", sourceHash: "hash-1" }],
      inlineCodeSpans: [{ text: "foo", domPath: "body.p.code[1]" }],
      textSlotIndices: [0],
    };

    const result = buildInlineGroupPlan(mappedItem, "使用 `bar`");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.foundInlineCodeSpans).toEqual(["bar"]);
  });
});
