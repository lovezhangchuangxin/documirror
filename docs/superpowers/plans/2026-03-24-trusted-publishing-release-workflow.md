# Trusted Publishing Release Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the release workflow from token-based npm publishing to pure GitHub Actions OIDC Trusted Publishing while preserving the existing changeset version PR flow.

**Architecture:** Keep `changesets/action` responsible for version PR creation, then publish in a separate workflow step when there are no remaining changesets on `master`. Remove `NPM_TOKEN` from the workflow so npm authentication must happen through OIDC.

**Tech Stack:** GitHub Actions, Changesets, pnpm, npm Trusted Publishing (OIDC)

---

### Task 1: Document the Trusted Publishing Design

**Files:**

- Create: `docs/superpowers/specs/2026-03-24-trusted-publishing-design.md`
- Create: `docs/superpowers/plans/2026-03-24-trusted-publishing-release-workflow.md`

- [ ] **Step 1: Write the design document**

- [ ] **Step 2: Write the implementation plan**

- [ ] **Step 3: Review both files for consistency with the approved design**

Run: `git diff -- docs/superpowers/specs/2026-03-24-trusted-publishing-design.md docs/superpowers/plans/2026-03-24-trusted-publishing-release-workflow.md`
Expected: docs describe a pure OIDC publish path with no `NPM_TOKEN`

### Task 2: Update the Release Workflow

**Files:**

- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Add an `id` to the changesets step and remove inline token-based publish**

- [ ] **Step 2: Remove `NPM_TOKEN` from the workflow environment**

- [ ] **Step 3: Add a separate OIDC publish step gated on `hasChangesets == 'false'`**

- [ ] **Step 4: Review the workflow diff**

Run: `git diff -- .github/workflows/release.yml`
Expected: `changesets/action` no longer has `publish: pnpm release` or `NPM_TOKEN`, and a separate publish step runs `pnpm release`

### Task 3: Update Release Process Documentation

**Files:**

- Modify: `CONTRIBUTING.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update contributor docs to describe npm Trusted Publishing via GitHub Actions**

- [ ] **Step 2: Add repository guidance that release automation should not depend on `NPM_TOKEN`**

- [ ] **Step 3: Review the diff for wording accuracy**

Run: `git diff -- CONTRIBUTING.md AGENTS.md`
Expected: docs mention GitHub Actions + npm Trusted Publishing (OIDC)

### Task 4: Validate the Workflow Change

**Files:**

- Modify: `.github/workflows/release.yml`
- Modify: `CONTRIBUTING.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Run repository lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 2: Inspect final workflow state and summarize remaining runtime prerequisites**

Run: `sed -n '1,160p' .github/workflows/release.yml`
Expected: workflow keeps `id-token: write` and publishes through a separate OIDC step
