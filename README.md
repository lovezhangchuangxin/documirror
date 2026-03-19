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

- CLI commands for `init`, `crawl`, `extract`, `translate plan`, `translate apply`, `build`, `update`, `doctor`, and `status`
- a `pnpm` workspace split into crawler, parser, i18n, builder, and CLI packages
- segment-level incremental translation planning based on `sourceHash`
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
   Export task JSON files only for new, stale, or missing translations.
5. External translation
   Process pending task files with an external agent and write result JSON files.
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
│   └── manifest.json
└── tasks/
    ├── applied/
    ├── done/
    ├── in-progress/
    └── pending/
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

## Translation Task Workflow

DocuMirror does not call external AI tools directly in v0.1. Instead, it exchanges files with them.

Pending tasks are written to:

```text
.documirror/tasks/pending/
```

Each task JSON includes:

- target locale
- translation instructions
- glossary entries
- segment IDs
- source hashes
- source text
- context such as page URL, DOM path, and tag name

External tools should write result files to:

```text
.documirror/tasks/done/
```

Result files must include:

- `taskId`
- `provider`
- `completedAt`
- translated items keyed by `segmentId` and `sourceHash`

`translate apply` validates the result schema and only accepts translations whose `sourceHash` still matches the current source segment.

## Incremental Translation Model

Incremental behavior is segment-based, not page-based:

- every extracted segment gets a stable `segmentId`
- every normalized source text gets a `sourceHash`
- when the source hash changes, the previous translation becomes stale
- only new, stale, or missing accepted translations are exported in the next translation plan
- compatible files already present under `.documirror/tasks/pending/` are retained across repeated planning runs

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
