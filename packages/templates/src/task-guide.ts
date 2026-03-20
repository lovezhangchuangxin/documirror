export function createTaskGuide(): string {
  return `# DocuMirror API Translation Workflow

This document is the operating guide for automatic API translation and manual result review.

## Source Of Truth

- \`.documirror/tasks/manifest.json\` is the machine-readable task state
- \`.documirror/tasks/QUEUE.md\` is the generated checklist view
- Do **NOT** edit either file by hand

## Standard Workflow

1. Generate translation tasks:

\`\`\`bash
documirror translate plan --repo .
\`\`\`

2. Run automatic translation:

\`\`\`bash
documirror translate run --repo .
\`\`\`

   If a run looks stuck, rerun it with debug logs enabled:

\`\`\`bash
documirror translate run --repo . --debug
\`\`\`

3. Verify a generated result if needed:

\`\`\`bash
documirror translate verify --repo . --task <taskId>
\`\`\`

4. Apply verified results:

\`\`\`bash
documirror translate apply --repo .
\`\`\`

If automatic translation fails for a task, inspect \`reports/translation-run/<taskId>.json\`, adjust the AI config or prompt inputs, then rerun \`translate run\`. Use \`--debug\` when you need to see whether it is blocked on task loading, the API request, first streamed content, response parsing, validation, or retry handling.

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
- Keep surrounding natural language in the same slots before, between, and after inline code
- Do not move words across inline code boundaries
- Example: \`Use \`snap-always\` here\` -> \`这里使用 \`snap-always\`\`

### 5. Formatting Preservation
- Preserve list numbering
- Preserve markdown emphasis and links
- Preserve placeholders and HTML entities

### 6. Queue Discipline
- Do not edit \`.documirror/tasks/manifest.json\` or \`.documirror/tasks/QUEUE.md\`
- Keep provider tokens in \`.env\`
- Rerun \`translate run\` instead of inventing ad hoc side channels

## Result Schema

\`\`\`json
{
  "schemaVersion": 2,
  "taskId": "task_xxx",
  "provider": "openai",
  "model": "gpt-4.1-mini",
  "completedAt": "2026-03-20T12:00:00.000Z",
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

## What Verify Checks

- \`taskId\` matches the claimed task
- \`translations.length === content.length\`
- \`translations[].id\` is strictly \`1..N\`
- no missing, duplicate, or extra ids
- no empty \`translatedText\`
- leading list markers such as \`1.\`, \`-\`, and \`- [ ]\` are preserved
- glossary targets are present when matching source terms appear
- placeholders such as \`{name}\`, \`{{value}}\`, \`%s\`, and \`<0>\` are preserved exactly
- lightweight markdown structures such as \`**bold**\`, \`~~strike~~\`, and \`[text](url)\` are preserved
- inline code spans are preserved for inline-code tasks
Verify may also warn when a translation is effectively identical to the source text.

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
