export function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export const PLACEHOLDER_TOKEN_REGEX =
  /\{\{[^{}]+\}\}|\{[A-Za-z0-9_.-]+\}|%(\d+\$)?[+#0\- ]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[sdifo]|<\/?\d+>|\$[A-Z_][A-Z0-9_]*/gu;

export function extractPlaceholderTokens(value: string): string[] {
  PLACEHOLDER_TOKEN_REGEX.lastIndex = 0;
  return [...value.matchAll(PLACEHOLDER_TOKEN_REGEX)].map((match) => match[0]);
}

export function replacePlaceholderTokens(
  value: string,
  replacement: string,
): string {
  PLACEHOLDER_TOKEN_REGEX.lastIndex = 0;
  return value.replace(PLACEHOLDER_TOKEN_REGEX, replacement);
}

export type InlineCodeParseResult = {
  textSegments: string[];
  inlineCodeSpans: string[];
};

export function parseInlineCodeSpans(
  value: string,
): InlineCodeParseResult | null {
  const textSegments: string[] = [];
  const inlineCodeSpans: string[] = [];
  let cursor = 0;
  let textBuffer = "";

  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      textBuffer += value[cursor];
      cursor += 1;
      continue;
    }

    const fenceLength = countBackticks(value, cursor);
    const fence = "`".repeat(fenceLength);
    const contentStart = cursor + fenceLength;
    const contentEnd = value.indexOf(fence, contentStart);
    if (contentEnd < 0) {
      return null;
    }

    textSegments.push(textBuffer);
    textBuffer = "";
    inlineCodeSpans.push(value.slice(contentStart, contentEnd));
    cursor = contentEnd + fenceLength;
  }

  textSegments.push(textBuffer);
  return {
    textSegments,
    inlineCodeSpans,
  };
}

function countBackticks(value: string, startIndex: number): number {
  let length = 0;

  while (value[startIndex + length] === "`") {
    length += 1;
  }

  return length;
}
