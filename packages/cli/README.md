# @documirror/cli

CLI for building translated mirrors of static documentation websites.

DocuMirror crawls a source docs site, extracts translatable HTML text and
attributes, writes page-based translation task files, runs translation through
an OpenAI-compatible API, verifies the results, and rebuilds a deployable
translated static mirror.

## Install

```bash
npm install --global @documirror/cli
documirror --help
```

For a one-off run:

```bash
pnpm dlx @documirror/cli --help
```

## Quick Start

Initialize a mirror repository:

```bash
documirror init --repo ./my-mirror
cd ./my-mirror
```

Once you are inside the mirror repository root, `--repo` defaults to the
current directory and can be omitted.

Run the one-shot automatic pipeline:

```bash
documirror auto
```

This runs `update`, `translate run`, `translate apply`, and `build` in order. If translation leaves some tasks failed, `auto` still applies successful results and builds the site, but returns a non-zero exit code.

For manual control, you can still run the incremental update step directly:

```bash
documirror update
```

Inspect current status:

```bash
documirror status
documirror doctor
```

## Links

- Repository: <https://github.com/lovezhangchuangxin/documirror>
- English docs: <https://github.com/lovezhangchuangxin/documirror#readme>
- Chinese docs: <https://github.com/lovezhangchuangxin/documirror/blob/main/README.zh.md>
