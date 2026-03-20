# AGENTS.md

This file is the repository-level guide for AI coding agents and contributors working on DocuMirror.

For product-facing context, read:

- `README.md` for the English overview
- `README.zh.md` for the Chinese overview

README files should stay focused on product purpose, scope, workflow, and usage. Repository conventions, contribution rules, and agent-specific instructions belong here.

## Project Purpose

DocuMirror is a TypeScript monorepo for building translated mirrors of static documentation websites.

The current implementation is designed to:

- crawl a source documentation site
- extract translatable HTML text and attributes
- export page-based translation task files
- call a configured OpenAI-compatible API to translate those tasks automatically
- validate translation results
- rebuild translated HTML into a deployable static mirror

## Active Scope

Treat these as current product constraints unless the task explicitly changes them:

- static-HTML-first documentation sites
- one source site per mirror repository
- one target locale per mirror repository
- one configured LLM endpoint per mirror repository
- file-based translation workflow
- local JSON/JSONL state under `.documirror/`
- token storage in repository-local `.env`

Do not assume support for:

- login-protected sites
- browser-rendered SPA crawling
- built-in provider-specific APIs beyond OpenAI-compatible chat completions
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
- `openai` npm package for OpenAI-compatible LLM calls

## Package Responsibilities

- `packages/cli`
  CLI entrypoint and interactive command wiring
- `packages/core`
  orchestration, repository state, validation, and pipeline commands
- `packages/crawler`
  page and asset crawling
- `packages/parser`
  HTML extraction and assembly-map generation
- `packages/i18n`
  translation state and incremental logic
- `packages/adapters-filequeue`
  task/result file serialization helpers
- `packages/adapters-openai`
  OpenAI-compatible API calls, connection tests, and LLM request shaping
- `packages/site-builder`
  translated HTML assembly and site output
- `packages/shared`
  shared types, schemas, hashing, and URL/path helpers
- `packages/templates`
  init-time config defaults and task guide text

## Architectural Invariants

These behaviors are central to the current design and should be preserved unless the task explicitly changes them:

- `segmentId` identifies a stable extraction binding for a page + DOM path + kind.
- `sourceHash` represents the normalized source content used for incremental translation decisions.
- task/result files may use short item IDs, but core state must map them back to `segmentId` and `sourceHash` internally.
- `translate plan` must only export segments that are new, stale, or missing accepted translations.
- `translate run` must validate model output before writing final result files.
- `translate run` may split a large page task into a few runtime chunks internally, but the persisted task and result files remain page-based.
- `translate apply` must reject stale results whose `sourceHash` no longer matches the current source segment.
- core owns orchestration; CLI should remain thin and interactive.
- shared schemas belong in `packages/shared`.
- provider-specific request handling should stay inside `packages/adapters-openai`, not leak across packages.

## Engineering Rules

- Keep package boundaries clean and avoid cross-package leakage of feature logic.
- Keep schemas explicit and validated with `zod`.
- Keep repository state inspectable on disk; do not introduce a database unless explicitly requested.
- Preserve the static-site-first assumption unless the task explicitly expands scope.
- Avoid browser automation or heavy runtime dependencies without a clear need.
- Match the existing ESM and TypeScript style.
- If a feature changes the task or result JSON contract, update both schemas and documentation.
- Keep auth token handling centered on `.env`; do not move tokens into `.documirror/config.json` by default.

## Repository Workflow

Install dependencies with:

```bash
pnpm install
```

The `prepare` script installs Git hooks through `simple-git-hooks`.

Configured hooks:

- `pre-commit`
  Runs `pnpm exec lint-staged`, `pnpm lint`, and `pnpm format:check`
- `commit-msg`
  Runs `pnpm exec commitlint --edit $1`
- `pre-push`
  Runs `pnpm typecheck` and `pnpm test`

### Commit Messages

Commit messages must use the `type(scope): subject` format.

Examples:

```text
feat(core): add automatic api translation runner
fix(cli): validate ai connection before saving config
docs(repo): rewrite workflow guide
```

Use conventional commit types supported by `commitlint`, and always include a scope.

Allowed scopes:

- `repo`
- `docs`
- `cli`
- `core`
- `crawler`
- `parser`
- `i18n`
- `shared`
- `site-builder`
- `templates`
- `adapters-filequeue`
- `adapters-openai`

If a change spans multiple packages, choose the narrowest scope that best represents the primary impact.

## Where To Put Changes

- New CLI flags or commands: `packages/cli`
- Pipeline orchestration, validation, `.env` handling, or repository storage: `packages/core`
- OpenAI-compatible request/response behavior: `packages/adapters-openai`
- HTML discovery or fetching behavior: `packages/crawler`
- Extraction heuristics or DOM path logic: `packages/parser`
- Incremental translation planning or state: `packages/i18n`
- Task/result file contract changes: `packages/adapters-filequeue` and `packages/shared`
- HTML reinsertion or output behavior: `packages/site-builder`
- Shared types, config schemas, or utilities: `packages/shared`

## Validation Expectations

For non-trivial code changes, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

If the change affects package entrypoints or build output, also run:

```bash
pnpm build
```

For documentation-only changes, a full validation pass is not required unless the task explicitly asks for it.

## Documentation Expectations

Update documentation when changing:

- CLI commands or flags
- repository structure
- task or result JSON shape
- AI configuration shape or `.env` behavior
- supported site scope
- major workflow assumptions
- repository conventions such as hooks or commit rules

Documentation ownership rules:

- `README.md` and `README.zh.md` are user-facing and should explain product scope, workflow, and usage.
- `AGENTS.md` is contributor-facing and should capture repository conventions, engineering rules, and agent guidance.
- User-facing behavior changes should update both README files.
- Repository process changes should update `AGENTS.md`.
- Do not move contribution rules such as commit conventions back into README unless they become directly relevant to end users.

## Common Commands

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

## Current Gaps

The current codebase is an initial foundation, not a complete production crawler. Likely future work includes:

- site-specific profiles for common docs frameworks
- stronger placeholder and inline-markup protection
- richer model prompt controls
- optional model fallback strategies
- better asset and link normalization
- richer health reports

Prefer incremental additions over large rewrites.
