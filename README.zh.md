# DocuMirror

[English](./README.md)

DocuMirror 是一个 TypeScript monorepo，用来构建静态文档站的翻译镜像。

它会抓取源文档站，抽取 HTML 中可翻译的文本和属性，生成按页面组织的翻译任务文件，并在页面过大时于运行时拆成少数几个翻译分片，校验结果，然后把翻译内容重新装配回 HTML，最终生成可部署的静态镜像站。

仓库约定与贡献规则见 [AGENTS.md](./AGENTS.md)。

## 概览

DocuMirror 适合需要这些能力的文档团队：

- 保留原站结构与 URL
- 做增量更新而不是整站重翻
- 使用易于检查的文件状态
- 直接通过 API 自动翻译，而不是手动管理 agent 队列

当前仓库提供：

- `init`、`config ai`、`crawl`、`extract`、`translate plan`、`translate run`、`translate verify`、`translate apply`、`build`、`update`、`auto`、`doctor`、`status` 命令
- 基于 `pnpm` workspace 的 crawler、parser、i18n、builder、OpenAI adapter、CLI 拆包结构
- 基于 `sourceHash` 的 segment 级增量翻译规划
- 按页面打包的任务文件与短 ID
- 基于 `openai` npm 包、面向 OpenAI 兼容接口的并发自动翻译
- 保存在 `.documirror/` 下的本地 JSON/JSONL 状态

## 快速开始

安装 CLI：

```bash
npm install --global @documirror/cli
```

初始化镜像仓库：

```bash
documirror init --repo ./my-mirror
cd ./my-mirror
```

运行常用的一键完整流程：

```bash
documirror auto
```

需要时查看当前状态：

```bash
documirror status
documirror doctor
```

日常增量流程优先使用 `auto`。它会按顺序执行 `update`、`translate run`、`translate apply` 和 `build`。如果部分翻译 task 失败，它仍会导入成功结果并继续构建，但最终会返回非零退出码，方便 CI 和操作人员识别这次运行并不完整。

## 当前范围

当前实现刻意保持收敛：

- 面向公开、以静态 HTML 为主的文档站
- 一个镜像仓库只对应一个源站
- 一个镜像仓库只对应一个目标语言
- 一个镜像仓库只配置一个 LLM 接口
- 文件式翻译工作流

暂不支持：

- 需要登录的站点
- 强依赖前端渲染的 SPA
- 一个仓库同时管理多语言
- OpenAI 兼容 chat completions 之外的 provider 专用能力

## 流水线

端到端流程如下：

1. `init`
   交互式创建镜像仓库、写入 `.documirror/` 工作目录、采集 AI 配置，并把 token 写入 `.env`
2. `crawl`
   抓取源站页面和静态资源
3. `extract`
   解析 HTML，生成可翻译 segment 与 DOM 装配映射
4. `translate plan`
   仅为新增、过期或缺失 accepted 翻译的 segment 生成任务文件，并刷新任务清单
5. `translate run`
   并发调用配置好的 OpenAI 兼容 API，自动校验模型输出，并把通过校验的结果写入 `tasks/done/`。如果运行看起来卡住，可以加 `--debug` 输出每个 task 的请求阶段日志
6. `translate apply`
   再次校验并把结果导入翻译存储。排查本地导入较慢时，可以加 `--profile` 输出阶段耗时。
7. `build`
   把翻译内容重新写回 HTML，最后在 `site/` 下输出镜像站。排查本地构建较慢时，可以加 `--profile` 输出构建阶段耗时。对于 hydration 之后仍会把英文重新插回正文的站点，还可以显式开启 `build.runtimeReconciler`，让构建产物额外注入一个运行时兜底层，在浏览器里于 DOM 更新后重新修正文本文本节点和白名单属性。

常见的增量流程直接运行 `auto` 即可。需要手动控制或排障时，再运行 `update`，然后按需重复翻译、导入和构建。

## 仓库结构

```text
.
├── packages/
│   ├── adapters-filequeue/  # 任务文件导入导出辅助
│   ├── adapters-openai/     # OpenAI 兼容 API 适配层
│   ├── cli/                 # 命令行入口
│   ├── core/                # 编排与仓库状态
│   ├── crawler/             # 站点抓取与资源发现
│   ├── i18n/                # 翻译状态与增量逻辑
│   ├── parser/              # HTML 抽取与装配映射
│   ├── shared/              # 共享 schema、类型与工具
│   ├── site-builder/        # 翻译站点输出
│   └── templates/           # init 模板与任务说明
├── AGENTS.md
├── README.md
├── README.zh.md
└── package.json
```

执行 `init` 后，镜像仓库结构大致如下：

```text
.
├── .env
├── .documirror/
│   ├── TASKS.md
│   ├── config.json
│   ├── glossary.json
│   ├── cache/
│   │   ├── assets/
│   │   └── pages/
│   ├── content/
│   │   ├── segments.jsonl
│   │   └── translations.jsonl
│   ├── state/
│   │   ├── assembly.json
│   │   ├── manifest.json
│   │   └── task-mappings/
│   └── tasks/
│       ├── applied/
│       ├── done/
│       ├── manifest.json
│       ├── pending/
│       └── QUEUE.md
├── AGENTS.md
├── README.md
└── package.json
```

## 要求

- Node.js `>= 20`
- `pnpm` `10.x`

## 安装

全局安装已发布的 CLI：

```bash
npm install --global @documirror/cli
documirror --help
```

如果只是临时执行一次，也可以直接用：

```bash
pnpm dlx @documirror/cli --help
```

## 开发

安装依赖：

```bash
pnpm install
```

构建全部包：

```bash
pnpm build
```

运行校验：

```bash
pnpm lint
pnpm typecheck
pnpm test
```

从本地源码构建并全局注册 CLI：

```bash
pnpm build
cd packages/cli
pnpm link --global
documirror --help
```

## CLI 参考

安装 `@documirror/cli` 后，后续都使用 `documirror` 命令。

交互式初始化镜像仓库：

```bash
documirror init --repo ./my-mirror
cd ./my-mirror
```

进入镜像仓库根目录后，`--repo` 默认就是当前目录，可以省略。

后续修改 AI 配置：

```bash
documirror config ai
```

抓取源站：

```bash
documirror crawl
```

抽取可翻译内容：

```bash
documirror extract
```

生成翻译任务：

```bash
documirror translate plan
```

运行自动翻译：

```bash
documirror translate run
```

调试耗时过长或看起来卡住的翻译运行：

```bash
documirror translate run --debug
```

如需检查生成结果，可单独校验：

```bash
documirror translate verify --task <taskId>
```

导入翻译结果：

```bash
documirror translate apply
```

分析较慢的导入阶段：

```bash
documirror translate apply --profile
```

构建翻译镜像：

```bash
documirror build
```

分析较慢的构建阶段：

```bash
documirror build --profile
```

运行增量流水线：

```bash
documirror update
```

打开 translate run 调试日志执行完整自动流水线：

```bash
documirror auto --debug
```

检查仓库健康状态：

```bash
documirror doctor
documirror status
```

## AI 配置

镜像仓库的 AI 配置保存在：

```text
.documirror/config.json
```

认证 token 保存在：

```text
.env
```

当前 AI 配置字段包括：

- `llmProvider`
- `baseUrl`
- `modelName`
- `authTokenEnvVar`
- `concurrency`
- `requestTimeoutMs`
- `maxAttemptsPerTask`
- `temperature`
- `chunking.enabled`
- `chunking.strategy`
- `chunking.maxItemsPerChunk`
- `chunking.softMaxSourceCharsPerChunk`
- `chunking.hardMaxSourceCharsPerChunk`

`init` 和 `config ai` 在保存前都会先做一次真实连通性测试。

## 翻译工作流

待处理任务写入：

```text
.documirror/tasks/pending/
```

任务状态也会写入：

```text
.documirror/tasks/manifest.json
.documirror/tasks/QUEUE.md
```

通过校验的结果写入：

```text
.documirror/tasks/done/
```

已应用历史归档到：

```text
.documirror/tasks/applied/
```

每个 task JSON 包含：

- 任务元数据
- 页面 URL 与可选标题
- glossary 条目
- 以 `1`、`2`、`3` 这类短 ID 编号的翻译项

结果文件包含：

- `taskId`
- `provider`
- `model`
- `completedAt`
- 按短 ID 对应的译文项

`translate run` 会把 task、glossary 和校验错误一起喂给模型，在模型输出 JSON 非法或校验失败时自动重试修复。现在会优先使用流式 chat completion，在 provider 不支持时自动回退到非流式，并把默认 AI 请求超时提高到更适合大任务的级别。对于内容很多的页面，它还可以在运行时按结构拆成少数几个 chunk，只重试失败的 chunk，再把通过校验的 chunk 结果合并回原始页面结果。加上 `--debug` 后，还会输出 task 加载、chunk 规划、请求发起、首个流式内容到达、响应完成、校验重试和结果写入这些阶段日志。`translate apply` 会把短 ID 映射回内部 `segmentId` 和 `sourceHash`，再次校验 schema，并且只接受 `sourceHash` 仍与当前源内容一致的翻译。

当 task 中包含 `` `snap-always` `` 这类内联代码时，结果文本必须保留相同的 inline code span 与顺序，DocuMirror 才能把译文正确拆回原始 DOM 结构。

## 增量行为

- `translate plan` 只导出新增、过期或缺失 accepted 翻译的 segment
- 重复执行 plan 时，会保留仍然兼容的 pending task
- `translate run` 对失败任务保留 `pending/` 状态，并把诊断信息写入 `reports/translation-run/`
- `translate apply` 会拒绝源内容已变化的 stale 结果

## License

MIT
