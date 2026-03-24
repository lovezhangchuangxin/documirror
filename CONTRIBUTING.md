# Contributing

Thanks for contributing to DocuMirror.

## Development setup

Requirements:

- Node.js `>= 24.0.0`
- pnpm `10.x`

Install dependencies:

```bash
pnpm install
```

Run the standard validation suite:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If you change npm packaging, CLI install behavior, or release automation, also run:

```bash
pnpm release:check
```

## Pull requests

- Keep package boundaries clean and align changes with the package responsibilities in `AGENTS.md`.
- Update `README.md` and `README.zh.md` for user-facing behavior changes.
- Update `AGENTS.md` for contributor workflow or repository process changes.
- Use conventional commits in the `type(scope): subject` format.

## Changesets and releases

DocuMirror publishes only the public CLI package, `@documirror/cli`.

When a change should be reflected in the next published version, create a changeset:

```bash
pnpm changeset
```

Typical cases that need a changeset:

- new CLI commands or flags
- behavior changes visible to users
- packaging changes
- documentation changes that materially affect installation or supported workflow

Maintainers generate versions with:

```bash
pnpm version-packages
```

Publishing is automated through GitHub Actions via npm Trusted Publishing
(OIDC) after the release PR is merged.
