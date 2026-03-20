# DocuMirror

[English README](./README.md)

DocuMirror 是一个用于构建静态文档站翻译镜像的 TypeScript monorepo。

它会抓取源文档站，抽取 HTML 中可翻译的文本和属性，导出给外部 AI agent（如 Claude Code、Codex）处理的任务文件，再把翻译结果重新装配回 HTML，最终生成可部署的静态镜像站。

仓库规范和协作约定集中放在 [AGENTS.md](./AGENTS.md)。

## 项目概览

DocuMirror 面向这样一类需求：

- 保留原始站点结构与 URL
- 拥有可重复执行的翻译流水线
- 支持增量更新，而不是每次整站重翻
- 使用可检查、可脚本化的文件状态

当前仓库已经提供可运行的 v0.1 基础能力：

- 提供 `init`、`crawl`、`extract`、`translate plan`、`translate claim`、`translate release`、`translate reclaim-expired`、`translate verify`、`translate complete`、`translate apply`、`build`、`update`、`doctor`、`status` 命令
- 使用 `pnpm workspace` 组织 crawler、parser、i18n、builder、CLI 等独立包
- 基于 `sourceHash` 的 segment 级增量翻译规划
- 面向外部 agent 的按页面任务装配与短序号内容项
- 通过文件队列适配第三方翻译 agent
- 在 `.documirror/` 下使用本地 JSON/JSONL 状态

## 当前范围

当前实现刻意保持收敛：

- 面向公开可访问、以静态 HTML 为主的文档站
- 一个镜像仓库对应一个源站
- 一个镜像仓库对应一个目标语言
- 仅支持文件式翻译工作流

当前不支持：

- 需要登录的站点
- 大量依赖前端运行时的 SPA 渲染
- 内置直接调用 Claude Code、Codex 等 CLI
- 单仓库多目标语言

## 工作流

完整流程如下：

1. `init`
   初始化镜像仓库及其 `.documirror/` 工作目录。
   重复执行 `init` 时，只会补齐缺失脚手架，不会覆盖已有状态。
2. `crawl`
   抓取源站页面和静态资源。
3. `extract`
   解析 HTML，生成可翻译 segment 和 DOM 装配映射。
4. `translate plan`
   仅为新增、过期或缺失翻译的内容导出任务 JSON，并刷新任务清单与看板。
5. `translate claim` / `translate release` / `translate reclaim-expired` / `translate verify` / `translate complete`
   按任务领取、填写草稿结果、执行校验，并把通过校验的结果放入 done 队列。
6. `translate apply`
   校验并导入可接受的翻译结果。
7. `build`
   将翻译内容重新写回 HTML，并在 `site/` 下生成静态镜像站。

若源站更新，可以先执行 `update`，再重复翻译、导入与构建步骤。

## 仓库结构

```text
.
├── packages/
│   ├── adapters-filequeue/  # 任务文件导入导出
│   ├── cli/                 # 命令行入口
│   ├── core/                # 编排与仓库状态
│   ├── crawler/             # 站点抓取与资源发现
│   ├── i18n/                # 翻译状态与增量逻辑
│   ├── parser/              # HTML 抽取与装配映射
│   ├── shared/              # 公共 schema、类型与工具
│   ├── site-builder/        # 翻译后站点输出
│   └── templates/           # init 模板与任务说明
├── AGENTS.md
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
│   ├── manifest.json
│   └── task-mappings/
└── tasks/
    ├── applied/
    ├── done/
    ├── in-progress/
    ├── manifest.json
    ├── pending/
    └── QUEUE.md
```

## 环境要求

- Node.js `>= 20`
- `pnpm` `10.x`

## 开发

安装依赖：

```bash
pnpm install
```

构建全部包：

```bash
pnpm build
```

运行验证：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

查看 CLI 帮助：

```bash
node packages/cli/dist/index.mjs --help
```

如需本地全局安装 CLI 进行调试，可执行：

```bash
pnpm build
cd packages/cli
pnpm link --global
documirror --help
```

链接后的 `documirror` 命令会指向 `packages/cli/dist/index.mjs`，因此修改 CLI 代码后需要先重新构建再执行。

## CLI 快速开始

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

领取下一个翻译任务：

```bash
node packages/cli/dist/index.mjs translate claim --repo ./my-mirror --worker codex-01
```

`claim` 在选择下一个任务前，会自动回收已经过期的 lease。

释放或回收任务：

```bash
node packages/cli/dist/index.mjs translate release --repo ./my-mirror --task <taskId>
node packages/cli/dist/index.mjs translate reclaim-expired --repo ./my-mirror
```

校验并完成一个已领取任务：

```bash
node packages/cli/dist/index.mjs translate verify --repo ./my-mirror --task <taskId>
node packages/cli/dist/index.mjs translate complete --repo ./my-mirror --task <taskId> --provider codex
```

导入翻译结果：

```bash
node packages/cli/dist/index.mjs translate apply --repo ./my-mirror
```

构建翻译镜像站：

```bash
node packages/cli/dist/index.mjs build --repo ./my-mirror
```

执行增量更新：

```bash
node packages/cli/dist/index.mjs update --repo ./my-mirror
```

检查仓库状态与健康度：

```bash
node packages/cli/dist/index.mjs doctor --repo ./my-mirror
node packages/cli/dist/index.mjs status --repo ./my-mirror
```

## Crawl 行为

crawler 相关设置位于 `.documirror/config.json`。

- `crawlConcurrency` 现在表示页面和资源合并后的总 HTTP 并发，而不是分别计算。
- `requestTimeoutMs`、`requestRetryCount`、`requestRetryDelayMs` 用于控制单次请求超时和瞬时失败时的有限重试。
- `crawl` 结束后会输出摘要，包括重试次数、`robots.txt` 跳过或降级、忽略的非法链接以及部分失败样本，而不是直接暴露原始请求栈。
- 如果入口页面全部抓取失败，或全部被 `robots.txt` 阻止，且最终没有任何缓存文件产出，命令会以更友好的错误信息退出。

常见 crawler 配置如下：

```json
{
  "crawlConcurrency": 4,
  "requestTimeoutMs": 15000,
  "requestRetryCount": 2,
  "requestRetryDelayMs": 500
}
```

## 翻译任务工作流

当前 v0.1 不直接调用外部 AI 工具，而是通过文件与它们交换任务和结果。

待处理任务会写入：

```text
.documirror/tasks/pending/
```

任务状态还会写入：

```text
.documirror/tasks/manifest.json
.documirror/tasks/QUEUE.md
```

推荐的 agent 流程：

1. 执行 `translate claim --worker <agent-name>`
2. 读取 `.documirror/tasks/pending/` 下的任务 JSON
3. 在 `.documirror/tasks/in-progress/` 下填写草稿结果
4. 执行 `translate verify`
5. 根据错误提示修正，直到校验通过
6. 执行 `translate complete`
7. 如果 worker 中断，执行 `translate release` 或 `translate reclaim-expired`
8. 全部任务完成后执行 `translate apply`

每个任务 JSON 包含：

- 目标语言
- 翻译说明
- glossary 条目
- 页面 URL 和标题
- 按页面阅读顺序排列的短序号内容项
- 原文，以及仅在必要时出现的简短上下文说明
- 用反引号包裹的内联代码，用于在保留术语的同时提供完整句子上下文
- 为了保证被 inline code 打断的句子连贯，任务项中可能会带上相邻但未变更的文本

草稿结果写入：

```text
.documirror/tasks/in-progress/
```

通过校验后的正式结果写入：

```text
.documirror/tasks/done/
```

草稿结果文件必须包含：

- `taskId`
- 以任务短序号 `id` 对齐的翻译结果

`translate verify` 会检查：

- 当前任务 lease 是否已经过期
- `translations.length === content.length`
- `translations[].id` 是否严格按 `1..N`
- 是否缺失、重复或出现多余 id
- 是否存在空的 `translatedText`
- `1.`、`-`、`- [ ]` 这类前导列表标记是否被保留
- 当命中 glossary 词条时，译文是否包含对应 target
- `{name}`、`{{value}}`、`%s`、`<0>` 这类 placeholder 是否被原样保留
- `**bold**`、`~~strike~~`、`[text](url)` 这类轻量 markdown 结构是否被保留
- inline code 是否按顺序保留

如果译文与原文几乎完全一致，`verify` 还会给出 warning，提示人工确认。

`translate complete` 会写出正式结果文件，包含：

- `taskId`
- `provider`
- `completedAt`
- 以任务短序号 `id` 对齐的翻译结果

`translate apply` 会先把短序号 `id` 映射回内部 `segmentId` 和 `sourceHash`，再校验结果 schema，并且只接受 `sourceHash` 仍与当前源文本一致的翻译。
当任务内容中出现像 `` `snap-always` `` 这样的内联代码时，结果文本必须按原样保留这些 code span 及其顺序，DocuMirror 才能把整句译文重新拆回原始 inline code 两侧的文本节点。

## 增量翻译模型

增量更新是按 segment，而不是按页面进行的：

- 每个抽取出的 segment 都有稳定的 `segmentId`
- 每个 segment 还会生成一个页面内的 `reuseKey`，用于在 DOM 路径变化时安全复用既有翻译
- 每段归一化后的源文本都会生成 `sourceHash`
- 当 `sourceHash` 变化时，旧翻译会变为 stale
- 下一次翻译规划只会导出新增、过期或缺失已接受翻译的 segment
- 如果 segment 只是同页内位置变化，但 `reuseKey` 唯一且 `sourceHash` 未变，DocuMirror 会自动继承已接受译文
- 对应当前内容的 `.documirror/tasks/pending/` 兼容页面任务会在重复规划时保留

这样当源站只改动少量内容时，翻译成本不会膨胀到整页级别。

## 当前抽取范围

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

相关 selector 和 attribute 规则配置在 `.documirror/config.json` 中。

## 设计原则

当前实现有几个明确取舍：

- 使用文件状态，而不是数据库
- 使用文件任务队列，而不是直接耦合外部工具
- 先支持静态 HTML，浏览器自动化留待后续
- 工作区保持 ESM-only

这些取舍让第一版更容易检查、自动化和渐进演进。

## 后续方向

后续较自然的迭代包括：

- 增加 Docusaurus、VitePress、MkDocs 等站点 profile
- 加强 placeholder 和内联标记保护
- 改进资源与内部链接归一化
- 提供更详细的健康度报告
- 增加外部翻译 CLI 的可选直接适配器

## License

当前仓库还没有添加许可证。
