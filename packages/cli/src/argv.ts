type NormalizeCliArgvOptions = {
  stripForwardedOptionSeparator?: boolean;
};

export function normalizeCliArgv(
  argv: string[],
  options: NormalizeCliArgvOptions = {},
): string[] {
  const { stripForwardedOptionSeparator = false } = options;

  if (!stripForwardedOptionSeparator || argv.length <= 2) {
    return argv;
  }

  const normalized = [argv[0] ?? "", argv[1] ?? ""];

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const nextToken = argv[index + 1];

    // Package managers insert `--` before forwarded long options.
    if (
      token === "--" &&
      typeof nextToken === "string" &&
      nextToken.startsWith("--") &&
      nextToken.length > 2
    ) {
      continue;
    }

    normalized.push(token ?? "");
  }

  return normalized;
}
