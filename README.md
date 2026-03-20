# DocuMirror

[中文说明](./README.zh.md)

DocuMirror is a TypeScript monorepo for building translated mirrors of static documentation websites.

It crawls a source docs site, extracts translatable HTML text and attributes, exports task files for external AI agents such as Claude Code or Codex, then reassembles translated content into a deployable static mirror.

Repository conventions and contribution rules live in [AGENTS.md](./AGENTS.md).

## Overview

DocuMirror is built for documentation teams that need both:

- the original site structure and URLs
- a repeatable translation workflow
- incremental updates instead of full retranslation
- file-based state that is easy to inspect and automate

The current repository already provides a working v0.1 foundation with:

- CLI commands for `init`, `crawl`, `extract`, `translate plan`, `translate claim`, `translate verify`, `translate complete`, `translate apply`, `build`, `update`, `doctor`, and `status`
- a `pnpm` workspace split into crawler, parser, i18n, builder, and CLI packages
- segment-level incremental translation planning based on `sourceHash`
- page-based translation task packs with short item ids for external agents
- a file-queue adapter for third-party translation agents
- local JSON/JSONL state stored under `.documirror/`

## Current Scope

The current implementation is intentionally narrow:

- public, static-HTML-first documentation sites
- one source site per mirror repository
- one target locale per mirror repository
- file-based translation workflow only

Not currently supported:

- login-protected sites
- JavaScript-heavy SPA rendering
- built-in direct invocation of Claude Code, Codex, or other CLIs
- multi-locale mirror repositories

## Pipeline

The end-to-end workflow is:

1. `init`
   Create a mirror repository and its `.documirror/` working structure.
   Re-running `init` fills in missing scaffold files without overwriting existing mirror state.
2. `crawl`
   Fetch source pages and static assets.
3. `extract`
   Parse HTML into translatable segments plus DOM assembly mappings.
4. `translate plan`
   Export task JSON files only for new, stale, or missing translations, and refresh the task queue manifest/checklist.
5. `translate claim` / `translate verify` / `translate complete`
   Claim one task at a time, write a draft result, validate it, then finalize it into the done queue.
6. `translate apply`
   Validate and import accepted translation results into the translation store.
7. `build`
   Reinsert translated content into HTML and emit a translated static mirror under `site/`.

For incremental updates, run `update`, then repeat translation, apply, and build as needed.

## Repository Layout

```text
.
├── packages/
│   ├── adapters-filequeue/  # task file export/import
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
.documirror/
├── TASKS.md
├── config.json
├── glossary.json
├── cache/
│   ├── assets/
│   └── pages/
├── content/
│   ├── segments.jsonl
│   └── translations.jsonl
├── state/
│   ├── assembly.json
│   ├── manifest.json
│   └── task-mappings/
└── tasks/
    ├── applied/
    ├── done/
    ├── in-progress/
    ├── manifest.json
    ├── pending/
    └── QUEUE.md
```

## Requirements

- Node.js `>= 20`
- `pnpm` `10.x`

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

Show CLI help:

```bash
node packages/cli/dist/index.mjs --help
```

Install the CLI globally for local debugging:

```bash
pnpm build
cd packages/cli
pnpm link --global
documirror --help
```

The linked `documirror` command points to `packages/cli/dist/index.mjs`, so rebuild after CLI changes before rerunning it.

## CLI Quick Start

Initialize a mirror repository:

```bash
node packages/cli/dist/index.mjs init https://docs.example.com --locale zh-CN --dir ./my-mirror
```

Crawl the source site:

```bash
node packages/cli/dist/index.mjs crawl --repo ./my-mirror
```

Extract translatable content:

```bash
node packages/cli/dist/index.mjs extract --repo ./my-mirror
```

Generate translation tasks:

```bash
node packages/cli/dist/index.mjs translate plan --repo ./my-mirror
```

Claim the next translation task:

```bash
node packages/cli/dist/index.mjs translate claim --repo ./my-mirror
```

Verify and complete a claimed task:

```bash
node packages/cli/dist/index.mjs translate verify --repo ./my-mirror --task <taskId>
node packages/cli/dist/index.mjs translate complete --repo ./my-mirror --task <taskId> --provider codex
```

Apply translated results:

```bash
node packages/cli/dist/index.mjs translate apply --repo ./my-mirror
```

Build the translated mirror:

```bash
node packages/cli/dist/index.mjs build --repo ./my-mirror
```

Run the incremental pipeline:

```bash
node packages/cli/dist/index.mjs update --repo ./my-mirror
```

Inspect repository health:

```bash
node packages/cli/dist/index.mjs doctor --repo ./my-mirror
node packages/cli/dist/index.mjs status --repo ./my-mirror
```

## Crawl Behavior

Crawler settings live in `.documirror/config.json`.

- `crawlConcurrency` is the total HTTP concurrency across both pages and assets.
- `requestTimeoutMs`, `requestRetryCount`, and `requestRetryDelayMs` control timeout and bounded retries for transient failures.
- `crawl` now prints a post-run summary for retries, `robots.txt` skips or fallbacks, invalid links, and sampled failures instead of surfacing raw request stacks.
- If crawl produces no cached files because entry pages fail or are entirely blocked by `robots.txt`, the command exits with a friendly fatal message.

Typical crawler settings:

```json
{
  "crawlConcurrency": 4,
  "requestTimeoutMs": 15000,
  "requestRetryCount": 2,
  "requestRetryDelayMs": 500
}
```

## Translation Task Workflow

DocuMirror does not call external AI tools directly in v0.1. Instead, it exchanges files with them.

Pending tasks are written to:

```text
.documirror/tasks/pending/
```

Queue state is also written to:

```text
.documirror/tasks/manifest.json
.documirror/tasks/QUEUE.md
```

Recommended agent workflow:

1. Run `translate claim`
2. Read the task JSON under `.documirror/tasks/pending/`
3. Fill the draft result scaffold under `.documirror/tasks/in-progress/`
4. Run `translate verify`
5. Fix every reported issue until verification passes
6. Run `translate complete`
7. Run `translate apply` after all queued tasks are complete

Each task JSON includes:

- target locale
- translation instructions
- glossary entries
- page URL and title
- ordered page content items with short `id` values
- source text and compact notes only where needed for context
- inline code rendered with backticks so terminology stays in sentence context without being translated
- unchanged neighboring text may be included when needed to keep a split sentence coherent around inline code

Draft results are written to:

```text
.documirror/tasks/in-progress/
```

Final verified result files are written to:

```text
.documirror/tasks/done/
```

Draft result files must include:

- `taskId`
- translated items keyed by the short task `id`

`translate verify` checks:

- `translations.length === content.length`
- `translations[].id` is strictly `1..N`
- no missing, duplicate, or extra ids
- no empty `translatedText`
- inline code spans are preserved in order

`translate complete` writes final result files with:

- `taskId`
- `provider`
- `completedAt`
- translated items keyed by the short task `id`

`translate apply` maps each short `id` back to internal `segmentId` and `sourceHash`, validates the result schema, and only accepts translations whose `sourceHash` still matches the current source segment.
When a task item contains inline code such as `` `snap-always` ``, result text must preserve the same inline code spans and order so DocuMirror can split the translated sentence back around the original inline code nodes.

## Incremental Translation Model

Incremental behavior is segment-based, not page-based:

- every extracted segment gets a stable `segmentId`
- every normalized source text gets a `sourceHash`
- when the source hash changes, the previous translation becomes stale
- only new, stale, or missing accepted translations are exported in the next translation plan
- compatible pending page task files already present under `.documirror/tasks/pending/` are retained across repeated planning runs

This keeps translation cost low when only a small portion of the source site changes.

## Extraction Coverage

The current parser focuses on:

- text nodes in regular content HTML
- common translatable attributes such as `title`, `alt`, `aria-label`, and `placeholder`
- selected SEO/meta content such as `description` and `og:*` title/description fields

By default it skips:

- `script`
- `style`
- `noscript`
- `pre`
- `code`

Selector and attribute rules are configured in `.documirror/config.json`.

## Design Principles

Some design choices are deliberate:

- file-based state instead of a database
- file-queue translation integration instead of direct tool coupling
- static HTML first, with browser automation deferred
- an ESM-only workspace

This keeps the first version inspectable, automation-friendly, and easier to evolve incrementally.

## Roadmap

Likely next steps:

- site profiles for Docusaurus, VitePress, and MkDocs
- stronger placeholder and inline-markup preservation
- better asset and internal link normalization
- richer health reports
- optional direct adapters for external translation CLIs

## License

No license has been added yet.
