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
      "documirror:crawl": "documirror crawl --repo .",
      "documirror:extract": "documirror extract --repo .",
      "documirror:translate:plan": "documirror translate plan --repo .",
      "documirror:translate:claim": "documirror translate claim --repo .",
      "documirror:translate:verify": "documirror translate verify --repo .",
      "documirror:translate:complete": "documirror translate complete --repo .",
      "documirror:translate:apply": "documirror translate apply --repo .",
      "documirror:build": "documirror build --repo .",
      "documirror:update": "documirror update --repo .",
      "documirror:doctor": "documirror doctor --repo .",
      "documirror:status": "documirror status --repo .",
    },
  };
}
