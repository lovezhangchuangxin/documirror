# AGENTS.md

This file is a repository-level guide for AI coding agents and contributors working on DocuMirror.

For product-level context, read:

- `README.md` for the English project overview
- `README.zh.md` for the Chinese project overview

## Project Purpose

DocuMirror is a TypeScript monorepo for building translated mirrors of static documentation websites.

The current implementation is designed to:

- crawl a source documentation site
- extract translatable HTML text and attributes
- export translation task files for third-party AI agents
- import translated results
- rebuild translated HTML into a deployable static mirror

## Current Scope

Treat these as active product constraints unless explicitly changed:

- static-HTML-first documentation sites
- one source site per mirror repository
- one target locale per mirror repository
- file-based translation workflow
- local JSON/JSONL state under `.documirror/`

Do not assume support for:

- login-protected sites
- browser-rendered SPA crawling
- built-in direct invocation of Claude Code, Codex, or other CLIs
- multi-locale mirror repositories

## Tech Stack

- Node.js `>= 20`
- `pnpm` workspace
- TypeScript
- ESM-only packages
- `tsdown` for builds
- `axios` for HTTP requests
- `cheerio` for HTML parsing
- `zod` for schemas and validation
- `vitest` for tests

## Workspace Layout

- `packages/cli`
  CLI entrypoint and command wiring
- `packages/core`
  orchestration, repository state, pipeline commands
- `packages/crawler`
  page and asset crawling
- `packages/parser`
  HTML extraction and assembly-map generation
- `packages/i18n`
  translation state and incremental logic
- `packages/adapters-filequeue`
  translation task export/import protocol
- `packages/site-builder`
  translated HTML assembly and site output
- `packages/shared`
  shared types, schemas, hashing, URL/path helpers
- `packages/templates`
  init-time config defaults and task guide text

## Important Invariants

These behaviors are central to the current architecture. Preserve them unless the task explicitly changes them.

- `segmentId` identifies a stable extraction binding for a page + DOM path + kind.
- `sourceHash` represents the normalized source content used for incremental translation decisions.
- `translate plan` must only export segments that are new, stale, or missing accepted translations.
- `translate apply` must reject stale results whose `sourceHash` no longer matches the current source segment.
- `core` owns orchestration. Feature logic should not be pushed into `cli`.
- shared schemas belong in `packages/shared`.
- translation-provider coupling should not leak into core workflow for v0.1; use the file-queue adapter unless the task explicitly expands the design.

## Common Commands

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

## Working Rules

- Prefer changes that keep package boundaries clean.
- Keep schemas explicit and validated with `zod`.
- Keep filesystem state inspectable; do not introduce a database unless explicitly requested.
- Preserve static-site-first assumptions unless the task explicitly expands scope.
- Avoid introducing browser automation or heavy runtime dependencies without a clear need.
- Match the existing ESM/TypeScript style.
- If a feature changes the task/result JSON contract, update both the schemas and the documentation.

## Where To Put Changes

- New CLI flags or commands: `packages/cli`
- Pipeline orchestration or repository storage: `packages/core`
- HTML discovery/fetching behavior: `packages/crawler`
- Extraction heuristics or DOM path logic: `packages/parser`
- Incremental translation planning/state: `packages/i18n`
- Task file protocol changes: `packages/adapters-filequeue` and `packages/shared`
- HTML reinsertion/output behavior: `packages/site-builder`
- Shared types/config/schema utilities: `packages/shared`

## Testing Expectations

For non-trivial code changes, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If behavior changes the build output or package entrypoints, also run:

```bash
pnpm build
```

## Documentation Expectations

Update documentation when changing:

- CLI commands or flags
- repository structure
- task/result JSON shape
- supported site scope
- major workflow assumptions

At minimum, keep `README.md` in sync. Update `README.zh.md` too when the user-facing behavior changes.

## Current Gaps

The current codebase is an initial foundation, not a complete production crawler. Likely future work includes:

- site-specific profiles for common docs frameworks
- stronger placeholder and inline-markup protection
- better asset/link normalization
- richer health reports
- optional direct adapters for external translation CLIs

When extending the project, prefer incremental additions over large rewrites.
