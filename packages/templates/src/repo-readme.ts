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
- \`.documirror/tasks/pending/\`: generated translation task files
- \`.documirror/tasks/in-progress/\`: claim files and draft result files
- \`.documirror/tasks/done/\`: verified result files waiting to be applied
- \`.documirror/tasks/manifest.json\`: machine-readable queue state
- \`.documirror/tasks/QUEUE.md\`: generated checklist for agents
- \`site/\`: built translated static site output
- \`reports/\`: doctor and translation verification reports

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

Claim the next translation task:

\`\`\`bash
pnpm documirror:translate:claim -- --worker <agent-name>
\`\`\`

Release a claimed task or reclaim expired leases:

\`\`\`bash
pnpm documirror:translate:release -- --task <taskId>
pnpm documirror:translate:reclaim-expired
\`\`\`

Verify and complete a claimed task:

\`\`\`bash
pnpm documirror:translate:verify -- --task <taskId>
pnpm documirror:translate:complete -- --task <taskId> --provider <agent-name>
\`\`\`

Apply verified results:

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
2. Check \`.documirror/tasks/QUEUE.md\`
3. Claim the next task with \`pnpm documirror:translate:claim -- --worker <agent-name>\`
4. Translate into \`.documirror/tasks/in-progress/<taskId>.result.json\`
5. Run \`pnpm documirror:translate:verify -- --task <taskId>\`
6. Fix every reported error until verification passes
7. Run \`pnpm documirror:translate:complete -- --task <taskId> --provider <agent-name>\`
8. If a worker stops, run \`pnpm documirror:translate:release -- --task <taskId>\` or \`pnpm documirror:translate:reclaim-expired\`
9. After all tasks are complete, run \`pnpm documirror:translate:apply\`
10. Run \`pnpm documirror:build\`

For the detailed agent operating rules, see \`.documirror/TASKS.md\`.
`;
}
