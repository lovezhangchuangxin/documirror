# DocuMirror

[中文说明](./README.zh.md)

DocuMirror is a TypeScript monorepo for building translated mirrors of static documentation websites.

It crawls a source docs site, extracts translatable HTML text and attributes, writes page-based translation task files, can split large page tasks into smaller runtime translation chunks, verifies the results, and reassembles translated content into a deployable static mirror.

Repository conventions and contribution rules live in [AGENTS.md](./AGENTS.md).

## Overview

DocuMirror is built for documentation teams that need:

- the original site structure and URLs
- incremental updates instead of full retranslation
- file-based state that is easy to inspect
- direct API-driven translation without manual agent queue management

The current repository provides:

- CLI commands for `init`, `config ai`, `crawl`, `extract`, `translate plan`, `translate run`, `translate verify`, `translate apply`, `build`, `update`, `auto`, `doctor`, and `status`
- a `pnpm` workspace split into crawler, parser, i18n, builder, OpenAI adapter, and CLI packages
- segment-level incremental translation planning based on `sourceHash`
- page-based translation task files with short item ids
- automatic concurrent translation through the `openai` npm package against OpenAI-compatible APIs
- local JSON/JSONL state stored under `.documirror/`

## Quick Start

Install the CLI:

```bash
npm install --global @documirror/cli
```

Initialize a mirror repository:

```bash
documirror init --repo ./my-mirror
cd ./my-mirror
```

Run the common end-to-end workflow:

```bash
documirror auto
```

Inspect current state when needed:

```bash
documirror status
documirror doctor
```

Use `auto` for the normal incremental flow. It runs `update`, `translate run`, `translate apply`, and `build` in order. If some translation tasks fail, it still applies successful results and builds the site, but exits non-zero so CI and operators can detect the incomplete run.

## Current Scope

The current implementation is intentionally narrow:

- public, static-HTML-first documentation sites
- one source site per mirror repository
- one target locale per mirror repository
- one configured LLM endpoint per mirror repository
- file-based translation workflow only

Not currently supported:

- login-protected sites
- JavaScript-heavy SPA rendering
- multi-locale mirror repositories
- provider-specific features beyond OpenAI-compatible chat completions

## Pipeline

The end-to-end workflow is:

1. `init`
   Create a mirror repository, write `.documirror/` state, collect AI settings interactively, and store the token in `.env`.
2. `crawl`
   Fetch source pages and static assets.
3. `extract`
   Parse HTML into translatable segments plus DOM assembly mappings.
4. `translate plan`
   Export task JSON files only for new, stale, or missing translations, and refresh the queue manifest/checklist.
5. `translate run`
   Call the configured OpenAI-compatible API concurrently, validate the model output, and write verified results into `tasks/done/`. `ai.concurrency` stays the only translation concurrency setting: page-level scheduling gets priority, and spare request slots can be borrowed by runtime chunks from the same page when fewer pages are active than the budget. Use `--debug` to print per-task request lifecycle logs when a run appears stuck.
6. `translate apply`
   Re-validate and import accepted translation results into the translation store. Add `--profile` to print stage timings while diagnosing slow local imports.
7. `build`
   Reinsert translated content into HTML and emit a translated static mirror under `site/`. Add `--profile` to print build-stage timings while diagnosing slow local builds. For sites whose client-side hydration reintroduces source-language text, you can opt into `build.runtimeReconciler`, which injects a runtime fallback that re-applies accepted body text and whitelisted attribute translations in the browser after DOM updates.

For the common incremental workflow, run `auto`. For manual control or troubleshooting, run `update`, then repeat translation, apply, and build as needed.

## Repository Layout

```text
.
├── packages/
│   ├── adapters-filequeue/  # task file export/import helpers
│   ├── adapters-openai/     # OpenAI-compatible API adapter
│   ├── cli/                 # command-line interface
│   ├── core/                # orchestration and repository state
│   ├── crawler/             # site crawling and asset discovery
│   ├── i18n/                # translation state and incremental logic
│   ├── parser/              # HTML extraction and assembly mapping
│   ├── shared/              # shared schemas, types, and helpers
│   ├── site-builder/        # translated site output
│   └── templates/           # init templates and task guide text
├── AGENTS.md
├── README.md
├── README.zh.md
└── package.json
```

After `init`, a mirror repository uses this working structure:

```text
.
├── .env
├── .documirror/
│   ├── TASKS.md
│   ├── config.json
│   ├── glossary.json
│   ├── cache/
│   │   ├── assets/
│   │   └── pages/
│   ├── content/
│   │   ├── segments.jsonl
│   │   └── translations.jsonl
│   ├── state/
│   │   ├── assembly.json
│   │   ├── manifest.json
│   │   └── task-mappings/
│   └── tasks/
│       ├── applied/
│       ├── done/
│       ├── manifest.json
│       ├── pending/
│       └── QUEUE.md
├── AGENTS.md
├── README.md
└── package.json
```

## Requirements

- Node.js `>= 24.0.0`
- `pnpm` `10.x`

## Install

Install the published CLI globally:

```bash
npm install --global @documirror/cli
documirror --help
```

For a one-off run without a global install:

```bash
pnpm dlx @documirror/cli --help
```

## Development

Install dependencies:

```bash
pnpm install
```

Build all packages:

```bash
pnpm build
```

Run validation:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Build and register the CLI globally from a local source checkout:

```bash
pnpm build
cd packages/cli
pnpm link --global
documirror --help
```

## CLI Reference

After installing `@documirror/cli`, run the CLI with `documirror`.

Initialize a mirror repository interactively:

```bash
documirror init --repo ./my-mirror
cd ./my-mirror
```

Once you are inside the mirror repository root, `--repo` defaults to the
current directory and can be omitted.

Update AI settings later:

```bash
documirror config ai
```

Crawl the source site:

```bash
documirror crawl
```

Extract translatable content:

```bash
documirror extract
```

Generate translation tasks:

```bash
documirror translate plan
```

Run automatic translation:

```bash
documirror translate run
```

Debug a slow or stuck translation run:

```bash
documirror translate run --debug
```

Verify a generated result if needed:

```bash
documirror translate verify --task <taskId>
```

Apply translated results:

```bash
documirror translate apply
```

Profile a slow apply step:

```bash
documirror translate apply --profile
```

Build the translated mirror:

```bash
documirror build
```

Profile a slow build:

```bash
documirror build --profile
```

Run the incremental pipeline:

```bash
documirror update
```

Run the full automatic pipeline with translate-run debug logs:

```bash
documirror auto --debug
```

Inspect repository health:

```bash
documirror doctor
documirror status
```

## AI Configuration

Mirror AI settings live in:

```text
.documirror/config.json
```

The auth token lives in:

```text
.env
```

Current AI configuration fields:

- `llmProvider`
- `baseUrl`
- `modelName`
- `authTokenEnvVar`
- `concurrency`
- `requestTimeoutMs`
- `maxAttemptsPerTask`
- `temperature`
- `chunking.enabled`
- `chunking.strategy`
- `chunking.maxItemsPerChunk`
- `chunking.softMaxSourceCharsPerChunk`
- `chunking.hardMaxSourceCharsPerChunk`

`init` and `config ai` both run a live connection test before saving.

## Translation Workflow

Pending tasks are written to:

```text
.documirror/tasks/pending/
```

Queue state is also written to:

```text
.documirror/tasks/manifest.json
.documirror/tasks/QUEUE.md
```

Verified translation results are written to:

```text
.documirror/tasks/done/
```

Applied history is archived under:

```text
.documirror/tasks/applied/
```

Each task JSON includes:

- task metadata
- page URL and optional title
- glossary entries
- task items keyed by short ids such as `1`, `2`, `3`

Result files include:

- `taskId`
- `provider`
- `model`
- `completedAt`
- translated items keyed by the short task `id`

`translate run` uses the task file, glossary, and validation feedback to retry malformed or invalid model output automatically. It now prefers streamed chat completions when the provider supports them, falls back to non-streaming mode when needed, and uses a longer default AI request timeout. For large page tasks, it can split one page into a few structural runtime chunks, retry only the failing chunk, and merge the verified chunk results back into the original page result file. The same `concurrency` setting is reused for both page scheduling and runtime chunks: DocuMirror first fills the budget with pages, then lets already-active pages borrow any spare request slots for extra chunks. Persisted task and result files remain page-based. Add `--debug` to print stage logs such as task loading, chunk planning, request start, first streamed content, response completion, validation retry, and result writing. `translate apply` maps each short `id` back to internal `segmentId` and `sourceHash`, validates the result schema, and only accepts translations whose `sourceHash` still matches the current source segment.

When a task item contains inline code such as `` `snap-always` ``, result text must preserve the same inline code spans exactly. DocuMirror can now reorder inline code nodes during assembly when the translation needs a different natural-language word order.

## Incremental Behavior

- `translate plan` only exports segments that are new, stale, or missing accepted translations
- compatible pending page task files are retained across repeated planning runs
- `translate run` leaves failed tasks in `pending/` and writes diagnostic reports under `reports/translation-run/`
- `translate apply` rejects stale results if the source segment changed after planning

## License

MIT
