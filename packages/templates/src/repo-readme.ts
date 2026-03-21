export function createMirrorRepoReadme(
  siteUrl: string,
  targetLocale: string,
): string {
  return `# DocuMirror Mirror Repository

This repository stores the translated mirror workflow for:

- Source site: ${siteUrl}
- Target locale: ${targetLocale}

Use this repository to crawl the source docs site, translate queued task files, and build a deployable translated static mirror. If client-side hydration restores source-language copy, you can opt into the runtime reconciler fallback in \`.documirror/config.json\`.

Detailed repository rules live in \`AGENTS.md\`. Translation-task-specific instructions live in \`.documirror/TASKS.md\`.

## Requirements

- Node.js >= 20
- pnpm >= 10
- A globally available \`documirror\` CLI

If you are developing DocuMirror locally, you can expose the CLI globally with:

\`\`\`bash
pnpm --filter @documirror/cli build
pnpm --filter @documirror/cli link --global
\`\`\`

## Quick Start

Refresh source state and generate translation tasks:

\`\`\`bash
pnpm documirror:update
\`\`\`

Run automatic translation:

\`\`\`bash
pnpm documirror:translate:run
\`\`\`

Large page tasks may be split into a few runtime chunks automatically, but the persisted task and result files remain page-based.

Debug a slow or stuck translation run:

\`\`\`bash
pnpm documirror:translate:run -- --debug
\`\`\`

Verify a generated result if needed:

\`\`\`bash
pnpm documirror:translate:verify -- --task <taskId>
\`\`\`

Apply verified translations and build the site:

\`\`\`bash
pnpm documirror:translate:apply
pnpm documirror:build
\`\`\`

## Common Commands

\`\`\`bash
pnpm documirror:update
pnpm documirror:build
pnpm documirror:status
pnpm documirror:doctor
\`\`\`

Run pipeline steps individually:

\`\`\`bash
pnpm documirror:crawl
pnpm documirror:extract
pnpm documirror:config:ai
pnpm documirror:translate:plan
pnpm documirror:translate:run
\`\`\`
`;
}
