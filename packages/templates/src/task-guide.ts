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
documirror translate plan
\`\`\`

2. Run automatic translation:

\`\`\`bash
documirror translate run
\`\`\`

   \`ai.concurrency\` is the only translation concurrency setting. DocuMirror uses it for page-level scheduling first, then lets runtime chunks borrow spare request slots only when fewer pages are active than the budget. Persisted task and result files still stay page-based.

   If a run looks stuck, rerun it with debug logs enabled:

\`\`\`bash
documirror translate run --debug
\`\`\`

3. Verify a generated result if needed:

\`\`\`bash
documirror translate verify --task <taskId>
\`\`\`

4. Apply verified results:

\`\`\`bash
documirror translate apply
\`\`\`

If automatic translation fails for a task, inspect \`reports/translation-run/<taskId>.json\`, adjust the AI config or prompt inputs, then rerun \`translate run\`. Use \`--debug\` when you need to see whether it is blocked on task loading, the API request, first streamed content, response parsing, validation, or retry handling.

## Translation Rules (MUST Follow)

### 1. Completeness
- Translate **every** task item
- Keep one source item mapped to one translation item
- Do not add explanations, notes, or extra commentary

### 2. Ordered IDs
- Copy task \`content\` ids exactly as they appear in the task file
- Full page tasks often use \`1, 2, 3, ...\`, but runtime chunks may keep original page ids
- Result \`translations\` ids must stay in exactly the same order
- Do not skip, duplicate, or renumber ids

### 3. Glossary Consistency
- Always check \`.documirror/glossary.json\`
- If a source term appears in the glossary, you must use the glossary target

### 4. Inline Code Preservation
- Backtick-wrapped text is inline code
- Never translate inline code
- Keep every inline code span exactly once
- You may reorder inline code and surrounding natural language when needed for natural target-language syntax
- Do not translate, drop, or duplicate inline code spans
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
- \`translations[].id\` exactly matches the task \`content[].id\` sequence
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
[id_out_of_order] $.translations[4].id: Expected translation id "44" at position 5 but found "45"
\`\`\`

Fix:

- renumber the result ids to match the task file ids exactly and in the same order

If verify says:

\`\`\`text
[inline_code_mismatch] $.translations[1].translatedText: Translation for id "2" must preserve inline code spans ["snap-always"] exactly
\`\`\`

Fix:

- keep \`snap-always\` unchanged inside backticks and move only the surrounding natural language
- if multiple inline code spans are present, you may reorder them for natural syntax, but every original inline code span must still appear exactly once
`;
}
