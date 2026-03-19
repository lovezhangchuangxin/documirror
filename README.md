# DocuMirror

[中文说明](./README.zh.md)

DocuMirror is a TypeScript monorepo for mirroring and translating static documentation websites.

It crawls a source docs site, extracts translatable HTML text and attributes, exports translation task files for external AI agents such as Claude Code or Codex, then reassembles translated content back into HTML to produce a deployable static mirror.

## Status

This repository already contains a working v0.1 foundation:

- CLI commands for `init`, `crawl`, `extract`, `translate plan`, `translate apply`, `build`, `update`, `doctor`, and `status`
- A `pnpm workspace` monorepo with separated packages for crawl, parse, i18n, build, and CLI
- Incremental translation planning based on segment-level source hashes
- File-queue integration for third-party agents
- Local JSON/JSONL state storage under `.documirror/`

Current scope is intentionally narrow:

- Public, static-HTML-heavy documentation sites
- One source site per mirror repository
- One target locale per mirror repository
- File-based translation workflow only

Not supported in the current implementation:

- Login-protected sites
- JavaScript-heavy SPA rendering
- Built-in direct integration with Claude Code / Codex CLI commands
- Multi-locale mirror repositories

## Why This Exists

Most doc translation workflows break down in one of two ways:

- They translate raw markdown or text, but lose the original site structure
- They mirror HTML, but do not provide a maintainable incremental translation workflow

DocuMirror is designed to keep both:

- the original website shape
- a structured extraction pipeline
- incremental translation state
- a clean handoff to external AI agents

## How It Works

The pipeline is:

1. `init`
   Create a mirror repository and `.documirror/` working structure.
2. `crawl`
   Fetch pages and static assets from the source site.
3. `extract`
   Parse HTML into translatable segments plus DOM assembly mappings.
4. `translate plan`
   Generate JSON task files for only new or changed segments.
5. External agent translation
   Translate pending task files and write result JSON files.
6. `translate apply`
   Validate and import translated results into the translation store.
7. `build`
   Reinsert translated content into HTML and emit a static mirror under `site/`.

For incremental updates, run `update`, then repeat translation/apply/build as needed.

## Repository Layout

```text
.
├── packages/
│   ├── adapters-filequeue/  # task file export/import
│   ├── cli/                 # command line interface
│   ├── core/                # orchestration and repository state
│   ├── crawler/             # site crawling and asset discovery
│   ├── i18n/                # translation state and incremental logic
│   ├── parser/              # HTML extraction and assembly mapping
│   ├── shared/              # shared schemas, types, helpers
│   ├── site-builder/        # translated site output
│   └── templates/           # init templates and task guide text
├── README.md
├── README.zh.md
└── package.json
```

After `init`, the mirror repository structure looks like this:

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

## Install

```bash
pnpm install
```

## Development

Build all packages:

```bash
pnpm build
```

Run checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Show CLI help:

```bash
node packages/cli/dist/index.mjs --help
```

## CLI Usage

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

Check repository health:

```bash
node packages/cli/dist/index.mjs doctor --repo ./my-mirror
node packages/cli/dist/index.mjs status --repo ./my-mirror
```

## Translation Task Workflow

DocuMirror does not call external AI tools directly in v0.1.

Instead, it writes task files into:

```text
.documirror/tasks/pending/
```

Each task is a JSON document containing:

- target locale
- translation instructions
- glossary entries
- segment IDs
- source hashes
- source text
- context such as page URL, DOM path, and tag name

External tools should write result files into:

```text
.documirror/tasks/done/
```

Result files must include:

- `taskId`
- `provider`
- `completedAt`
- translated items keyed by `segmentId` and `sourceHash`

`translate apply` validates the result schema and only accepts translations whose `sourceHash` still matches the current source segment.

## Incremental Update Model

Incremental behavior is segment-based, not page-based.

- Every extracted segment gets a stable `segmentId`
- Every normalized source text gets a `sourceHash`
- If the source hash changes, the previous translation becomes stale
- Only new or stale segments are exported in the next translation plan

This keeps translation cost lower when only small portions of a source site change.

## What Gets Extracted

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

Selector and attribute rules are stored in `.documirror/config.json`.

## Key Dependencies

The current implementation uses:

- `tsdown` for packaging TypeScript packages
- `axios` for HTTP requests
- `cheerio` for HTML parsing and traversal
- `zod` for schemas and validation
- `fs-extra` for filesystem operations
- `fast-glob` for file discovery
- `commander` for the CLI
- `vitest` for tests

## Design Notes

Some design choices are deliberate:

- File-based state instead of a database
- File-queue translation integration instead of direct tool coupling
- Static HTML first, browser automation later if needed
- ESM-only workspace

This keeps the first version simpler, inspectable, and easy to automate in CI or agent workflows.

## Roadmap

Likely next steps:

- site profiles for Docusaurus, VitePress, and MkDocs
- better asset and internal link normalization
- stronger placeholder and inline-markup preservation rules
- optional direct adapters for external translation CLIs
- richer reports for failed extraction or assembly drift

## License

No license has been added yet.
