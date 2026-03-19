# DocuMirror

[English README](./README.md)

DocuMirror 是一个用于镜像并翻译静态文档网站的 TypeScript monorepo。

它会抓取目标文档站，解析 HTML 中需要翻译的文本和属性，导出给外部 AI agent（如 Claude Code、Codex）处理的任务文件，再把翻译结果重新组装回 HTML，最终输出一个可部署的静态镜像站。

## 当前状态

当前仓库已经具备可运行的 v0.1 基础版本：

- 提供 `init`、`crawl`、`extract`、`translate plan`、`translate apply`、`build`、`update`、`doctor`、`status` 命令
- 使用 `pnpm workspace` 组织 crawl、parse、i18n、build、CLI 等独立包
- 基于 segment 级别 `sourceHash` 的增量翻译规划
- 通过文件任务队列与第三方 agent 集成
- 在 `.documirror/` 下使用本地 JSON/JSONL 持久化状态

当前实现的范围是刻意收敛的：

- 面向公开可访问、以静态 HTML 为主的文档站
- 一个镜像仓库对应一个源站
- 一个镜像仓库对应一个目标语言
- 翻译流程仅支持文件式任务队列

当前还不支持：

- 需要登录的站点
- 大量依赖前端运行时的 SPA 文档站
- 内置直接调用 Claude Code / Codex CLI
- 单仓库多目标语言

## 为什么做这个项目

文档翻译流程常见有两类问题：

- 只翻译原始 markdown 或纯文本，但丢失原网站结构
- 只镜像 HTML，但没有可持续维护的增量翻译流程

DocuMirror 试图同时保留这几件事：

- 原始网站的结构
- 结构化内容抽取
- 增量翻译状态
- 与外部 AI agent 的清晰交接面

## 工作流程

整体 pipeline 如下：

1. `init`
   初始化镜像仓库和 `.documirror/` 工作目录。
2. `crawl`
   抓取源站页面与静态资源。
3. `extract`
   解析 HTML，生成可翻译 segment 和 DOM 装配映射。
4. `translate plan`
   仅为新增或变更的 segment 生成翻译任务 JSON。
5. 外部 agent 翻译
   对待翻译任务文件进行处理，并写回结果文件。
6. `translate apply`
   校验并导入翻译结果。
7. `build`
   将翻译文本重新写回 HTML，输出 `site/` 静态镜像站。

如果源站有更新，可以执行 `update`，然后再次走翻译、导入和构建流程。

## 仓库结构

```text
.
├── packages/
│   ├── adapters-filequeue/  # 任务文件导入导出
│   ├── cli/                 # 命令行入口
│   ├── core/                # 编排与状态管理
│   ├── crawler/             # 页面抓取和资源发现
│   ├── i18n/                # 翻译状态和增量逻辑
│   ├── parser/              # HTML 抽取和装配映射
│   ├── shared/              # 公共 schema、类型、工具
│   ├── site-builder/        # 翻译后站点输出
│   └── templates/           # init 模板和任务说明
├── README.md
├── README.zh.md
└── package.json
```

执行 `init` 后，镜像仓库的工作目录结构如下：

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

## 环境要求

- Node.js `>= 20`
- `pnpm` `10.x`

## 安装

```bash
pnpm install
```

## 开发

构建全部包：

```bash
pnpm build
```

运行检查：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

查看 CLI 帮助：

```bash
node packages/cli/dist/index.mjs --help
```

## CLI 使用示例

初始化镜像仓库：

```bash
node packages/cli/dist/index.mjs init https://docs.example.com --locale zh-CN --dir ./my-mirror
```

抓取源站：

```bash
node packages/cli/dist/index.mjs crawl --repo ./my-mirror
```

抽取可翻译内容：

```bash
node packages/cli/dist/index.mjs extract --repo ./my-mirror
```

生成翻译任务：

```bash
node packages/cli/dist/index.mjs translate plan --repo ./my-mirror
```

导入翻译结果：

```bash
node packages/cli/dist/index.mjs translate apply --repo ./my-mirror
```

构建翻译后的镜像站：

```bash
node packages/cli/dist/index.mjs build --repo ./my-mirror
```

执行增量更新：

```bash
node packages/cli/dist/index.mjs update --repo ./my-mirror
```

检查状态与健康度：

```bash
node packages/cli/dist/index.mjs doctor --repo ./my-mirror
node packages/cli/dist/index.mjs status --repo ./my-mirror
```

## 翻译任务工作流

当前 v0.1 不直接调用外部 AI 工具。

DocuMirror 会把任务文件写入：

```text
.documirror/tasks/pending/
```

每个任务 JSON 会包含：

- 目标语言
- 翻译说明
- glossary
- segment ID
- source hash
- 原文
- 页面 URL、DOM 路径、标签名等上下文

外部工具应将结果写入：

```text
.documirror/tasks/done/
```

结果文件必须包含：

- `taskId`
- `provider`
- `completedAt`
- 以 `segmentId` 和 `sourceHash` 对齐的翻译结果

`translate apply` 会校验结果 schema，并且只接受 `sourceHash` 仍与当前源文本一致的翻译。

## 增量更新模型

增量更新是按 segment，而不是按页面进行的。

- 每个抽取出的 segment 都有稳定的 `segmentId`
- 每段归一化后的源文本都会生成 `sourceHash`
- 如果 `sourceHash` 变化，旧翻译会被标记为 stale
- 下一次 `translate plan` 只会导出新增或 stale 的 segment

这样当源站只改动少量内容时，翻译成本不会放大到整页级别。

## 当前会抽取什么内容

当前 parser 主要覆盖：

- 常规 HTML 内容中的文本节点
- 常见可翻译属性，如 `title`、`alt`、`aria-label`、`placeholder`
- 部分 SEO/meta 内容，如 `description` 和 `og:*` 标题/描述字段

默认会跳过：

- `script`
- `style`
- `noscript`
- `pre`
- `code`

相关 selector 和 attribute 规则保存在 `.documirror/config.json` 中。

## 关键依赖

当前实现主要使用：

- `tsdown` 进行 TypeScript 打包
- `axios` 发起 HTTP 请求
- `cheerio` 解析和遍历 HTML
- `zod` 做 schema 校验
- `fs-extra` 处理文件系统操作
- `fast-glob` 做文件发现
- `commander` 构建 CLI
- `vitest` 进行测试

## 设计取舍

当前实现有几个明确取舍：

- 先使用文件状态，不引入数据库
- 先使用文件任务队列，不直接耦合外部工具
- 优先支持静态 HTML，浏览器自动化留到后续
- 工作区默认使用 ESM

这样可以让第一版更容易检查、调试，并更适合与 agent/CI 流程集成。

## 后续方向

后续比较自然的迭代包括：

- 增加 Docusaurus、VitePress、MkDocs 等站点 profile
- 更完善的资源与内部链接归一化
- 更强的 placeholder 和内联标记保护
- 可选的外部翻译 CLI 直接适配器
- 更详细的抽取失败和回填漂移报告

## License

当前仓库还没有添加许可证。
