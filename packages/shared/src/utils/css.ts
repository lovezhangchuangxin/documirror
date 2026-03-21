export type CssUrlReference = {
  value: string;
  index: number;
  match: string;
};

export function extractCssUrlReferences(input: string): CssUrlReference[] {
  const references: CssUrlReference[] = [];

  for (const match of input.matchAll(createCssUrlPattern())) {
    const rawValue = toCssUrlValue(match[2], match[3], match[4]);
    if (!rawValue) {
      continue;
    }

    references.push({
      value: rawValue,
      index: match.index ?? 0,
      match: match[0],
    });
  }

  return references;
}

export function rewriteCssUrls(
  input: string,
  replacer: (value: string) => string | null | undefined,
): string {
  return input.replace(
    createCssUrlPattern(),
    (match, prefix, quote, quotedValue, unquotedValue, suffix) => {
      const rawValue = toCssUrlValue(quote, quotedValue, unquotedValue);
      if (!rawValue) {
        return match;
      }

      const replacement = replacer(rawValue);
      if (replacement == null) {
        return match;
      }

      if (quote) {
        return `${prefix}${quote}${replacement}${quote}${suffix}`;
      }

      return `${prefix}${replacement}${suffix}`;
    },
  );
}

function createCssUrlPattern(): RegExp {
  return /(url\(\s*)(?:(['"])(.*?)\2|((?:\\.|[^)])*?))(\s*\))/gis;
}

function toCssUrlValue(
  quote: string | undefined,
  quotedValue: string | undefined,
  unquotedValue: string | undefined,
): string | null {
  const rawValue = (quotedValue ?? unquotedValue ?? "").trim();
  if (!rawValue) {
    return null;
  }

  if (!quote && !isValidUnquotedCssUrl(rawValue)) {
    return null;
  }

  return rawValue;
}

function isValidUnquotedCssUrl(value: string): boolean {
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (
      /\s/.test(char) ||
      char === '"' ||
      char === "'" ||
      char === "(" ||
      char === ")"
    ) {
      return false;
    }
  }

  return true;
}
