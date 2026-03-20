export function createTaskGuide(): string {
  return `# DocuMirror Agent Translation Workflow

This document is the operating guide for external agents that translate DocuMirror task files.

## Source Of Truth

- \`.documirror/tasks/manifest.json\` is the machine-readable task state
- \`.documirror/tasks/QUEUE.md\` is the generated checklist view for agents
- Do **NOT** edit either file by hand

## Standard Workflow

1. Claim the next task:

\`\`\`bash
documirror translate claim --repo .
\`\`\`

If you need a specific task:

\`\`\`bash
documirror translate claim --repo . --task <taskId>
\`\`\`

2. Read the claimed task file from \`.documirror/tasks/pending/<taskId>.json\`
3. Fill the draft result scaffold at \`.documirror/tasks/in-progress/<taskId>.result.json\`
4. Verify the draft:

\`\`\`bash
documirror translate verify --repo . --task <taskId>
\`\`\`

5. Fix every reported error and run verify again until it passes
6. Finalize the verified draft into \`.documirror/tasks/done/\`:

\`\`\`bash
documirror translate complete --repo . --task <taskId> --provider <agent-name>
\`\`\`

7. After all queued tasks are complete, apply results:

\`\`\`bash
documirror translate apply --repo .
\`\`\`

## Translation Rules (MUST Follow)

### 1. Completeness
- Translate **every** task item
- Keep one source item mapped to one translation item
- Do not add explanations, notes, or extra commentary

### 2. Ordered IDs
- Task \`content\` ids are always \`1, 2, 3, ...\`
- Result \`translations\` ids must stay in exactly the same order
- Do not skip, duplicate, or renumber ids

### 3. Glossary Consistency
- Always check \`.documirror/glossary.json\`
- If a source term appears in the glossary, you must use the glossary target

### 4. Inline Code Preservation
- Backtick-wrapped text is inline code
- Never translate inline code
- Keep the same inline code spans in the same order
- Example: \`Use \`snap-always\` here\` -> \`这里使用 \`snap-always\`\`

### 5. Formatting Preservation
- Preserve list numbering
- Preserve markdown emphasis and links
- Preserve placeholders and HTML entities

## Draft Result Schema

\`\`\`json
{
  "schemaVersion": 2,
  "taskId": "task_xxx",
  "translations": [
    {
      "id": "1",
      "translatedText": "..."
    },
    {
      "id": "2",
      "translatedText": "..."
    }
  ]
}
\`\`\`

The \`complete\` command will fill \`provider\` and \`completedAt\` into the final result file.

## What Verify Checks

- \`taskId\` matches the claimed task
- \`translations.length === content.length\`
- \`translations[].id\` is strictly \`1..N\`
- no missing, duplicate, or extra ids
- no empty \`translatedText\`
- inline code spans are preserved for inline-code tasks

## Example Fixes

If verify says:

\`\`\`text
[id_out_of_order] $.translations[4].id: Expected translation id "5" at position 5 but found "6"
\`\`\`

Fix:

- renumber the result ids to match the task file exactly

If verify says:

\`\`\`text
[inline_code_mismatch] $.translations[1].translatedText: Translation for id "2" must preserve inline code spans ["snap-always"] in the original order
\`\`\`

Fix:

- keep \`snap-always\` unchanged inside backticks and move only the surrounding natural language
`;
}
