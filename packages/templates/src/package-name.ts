export function createPackageName(
  hostname: string,
  targetLocale: string,
): string {
  const normalizedHost = hostname
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const normalizedLocale = targetLocale
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `documirror-mirror-${normalizedHost}-${normalizedLocale}`;
}
