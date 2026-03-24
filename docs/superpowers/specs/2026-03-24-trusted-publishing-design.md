# Trusted Publishing Release Workflow Design

**Date:** 2026-03-24

## Goal

Migrate DocuMirror's npm release workflow from token-based publishing to pure
npm Trusted Publishing with GitHub Actions OIDC.

## Scope

This change updates:

- the GitHub Actions release workflow
- contributor-facing release process documentation

This change does not:

- alter package names or publishing access on npm
- change the changeset-based version PR flow
- add fallback token-based publishing paths

## Design

The repository should keep using `changesets/action` to open and update version
PRs, but the actual npm publish step should be separated from that action.

The updated flow is:

1. run release validation on pushes to `master`
2. run `changesets/action` with `version: pnpm version-packages`
3. if changesets exist, let the action open or update the version PR
4. if no changesets remain, run `pnpm release` in a separate workflow step so
   npm CLI can authenticate through GitHub Actions OIDC

`NPM_TOKEN` should be removed from the workflow entirely. `GITHUB_TOKEN` stays
because the release PR workflow still needs GitHub API access. The workflow
must keep `id-token: write`, and the workflow filename must remain
`.github/workflows/release.yml` so it continues to match npm Trusted Publisher
configuration exactly.

## Validation

Validation for this change is mostly static:

- inspect the workflow diff to confirm there is no `NPM_TOKEN` path left
- confirm `changesets/action` has an `id` and no inline `publish` command
- confirm a separate publish step runs only when `hasChangesets == 'false'`
- run repository validation to ensure no unrelated breakage

## Risks

- if npm Trusted Publisher settings on `@documirror/cli` do not exactly match
  this repository and workflow filename, publish will fail at runtime
- removing `NPM_TOKEN` means there is no longer any fallback path for publish
- this design assumes GitHub-hosted runners, which is consistent with npm's
  current Trusted Publishing support
