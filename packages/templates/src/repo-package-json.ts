import { createPackageName } from "./package-name";

export function createMirrorRepoPackageJson(
  siteUrl: string,
  targetLocale: string,
): Record<string, unknown> {
  const sourceUrl = new URL(siteUrl);
  const repoName = createPackageName(sourceUrl.hostname, targetLocale);

  return {
    name: repoName,
    private: true,
    version: "0.1.0",
    description: `Translated mirror workspace for ${sourceUrl.origin} (${targetLocale})`,
    packageManager: "pnpm@10.22.0",
    engines: {
      node: ">=20",
    },
    scripts: {
      "documirror:init": "documirror init",
      "documirror:crawl": "documirror crawl",
      "documirror:extract": "documirror extract",
      "documirror:config:ai": "documirror config ai",
      "documirror:translate:plan": "documirror translate plan",
      "documirror:translate:run": "documirror translate run",
      "documirror:translate:verify": "documirror translate verify",
      "documirror:translate:apply": "documirror translate apply",
      "documirror:build": "documirror build",
      "documirror:update": "documirror update",
      "documirror:doctor": "documirror doctor",
      "documirror:status": "documirror status",
    },
  };
}
