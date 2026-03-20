export function createMirrorRepoReadme(
  siteUrl: string,
  targetLocale: string,
): string {
  return `# DocuMirror Mirror Repository

This repository stores the translated mirror workflow for:

- Source site: ${siteUrl}
- Target locale: ${targetLocale}

Use this repository to crawl the source docs site, translate queued task files, and build a deployable translated static mirror.

Detailed agent and repository rules live in \`AGENTS.md\`. Translation-task-specific instructions live in \`.documirror/TASKS.md\`.

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

Claim the next translation task:

\`\`\`bash
pnpm documirror:translate:claim -- --worker <agent-name>
\`\`\`

When a \`pnpm documirror:*\` script needs extra CLI flags such as \`--worker\`, \`--task\`, or \`--provider\`, keep the extra \`--\` so pnpm forwards those flags to the DocuMirror CLI.

Verify and finalize the claimed result:

\`\`\`bash
pnpm documirror:translate:verify -- --task <taskId>
pnpm documirror:translate:complete -- --task <taskId> --provider <agent-name>
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
pnpm documirror:translate:plan
\`\`\`

If a worker stops, release or reclaim a task:

\`\`\`bash
pnpm documirror:translate:release -- --task <taskId>
pnpm documirror:translate:reclaim-expired
\`\`\`
`;
}
