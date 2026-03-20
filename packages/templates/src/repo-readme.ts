export function createMirrorRepoReadme(
  siteUrl: string,
  targetLocale: string,
): string {
  return `# DocuMirror Mirror Repository

This repository stores the translated mirror workflow for:

- Source site: ${siteUrl}
- Target locale: ${targetLocale}

## Requirements

- Node.js >= 20
- pnpm >= 10
- A globally available \`documirror\` CLI

If you are developing DocuMirror locally, you can expose the CLI globally with:

\`\`\`bash
pnpm --filter @documirror/cli build
pnpm --filter @documirror/cli link --global
\`\`\`

## Repository Layout

- \`.documirror/config.json\`: mirror configuration
- \`.documirror/state/manifest.json\`: page and asset manifest
- \`.documirror/content/segments.jsonl\`: extracted source segments
- \`.documirror/content/translations.jsonl\`: accepted translations
- \`.documirror/tasks/pending/\`: translation tasks for external agents
- \`.documirror/tasks/done/\`: translation result files waiting to be applied
- \`site/\`: built translated static site output
- \`reports/\`: doctor and verification reports

## Common Commands

Update crawl state and generate translation tasks:

\`\`\`bash
pnpm documirror:update
\`\`\`

Run the steps separately:

\`\`\`bash
pnpm documirror:crawl
pnpm documirror:extract
pnpm documirror:translate:plan
\`\`\`

After an external AI agent writes result files into \`.documirror/tasks/done/\`, apply them:

\`\`\`bash
pnpm documirror:translate:apply
\`\`\`

Build the translated mirror:

\`\`\`bash
pnpm documirror:build
\`\`\`

Inspect repository state:

\`\`\`bash
pnpm documirror:status
pnpm documirror:doctor
\`\`\`

## Translation Workflow

1. Run \`pnpm documirror:update\`
2. Read task files from \`.documirror/tasks/pending/\`
3. Translate each page task with your preferred AI agent using the short item ids in the JSON, keeping any inline code wrapped in backticks unchanged
4. Write result JSON files into \`.documirror/tasks/done/\`
5. Run \`pnpm documirror:translate:apply\`
6. Run \`pnpm documirror:build\`

For task and result JSON examples, see \`.documirror/TASKS.md\`.
`;
}
