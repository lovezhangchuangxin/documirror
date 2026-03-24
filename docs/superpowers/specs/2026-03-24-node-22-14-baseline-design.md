# Node 22.14.0 Baseline Alignment Design

**Date:** 2026-03-24

## Goal

Raise DocuMirror's supported Node.js baseline from `>= 20` to `>= 22.14.0`
and align repository metadata, generated templates, CI, release automation,
and CLI build targeting with that single baseline.

## Scope

This change updates:

- repository-level `engines.node` declarations
- published CLI `engines.node` declarations
- generated mirror repository templates
- user-facing and contributor-facing documentation
- GitHub Actions CI and release workflows
- the CLI bundle target in `tsdown`

This change does not:

- modify the supported `pnpm` range
- introduce new runtime features that require additional application logic
- change release package names or npm publishing behavior

## Design

DocuMirror should advertise one minimum supported Node.js version everywhere:
`22.14.0`. Any place that currently says `>= 20`, uses `20` in CI/release, or
targets `node20` in the CLI bundle should move to the new baseline.

The implementation stays mechanical and low-risk:

1. update runtime declarations in workspace package manifests
2. update generated template content so new mirror repositories inherit the same
   requirement
3. update README and contributor docs so humans see the same baseline
4. update GitHub Actions so validation and release automation run on the same
   floor version
5. update the CLI build target to `node22`

## Validation

The change is configuration-heavy, so verification focuses on consistency and
basic repository health:

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

Additional spot checks:

- inspect workflow YAML diffs for Node 22.14.0 alignment
- inspect template output code paths to ensure generated repositories inherit
  `>= 22.14.0`

## Risks

- CI matrix changes may remove older-version coverage that existed before
- release automation still depends on npm-side publishing permissions; this
  change does not fix npm scope ownership issues by itself
- if any local environment still uses Node 20, installs will now fail earlier
  via `engines`
