# claude-zh

> 给 Claude Code CLI 一个像样的中文界面。不改模型行为，一键可逆。

`macOS arm64` · `Node 18+` · `MIT`

---

## Before / After

**原版：**

```text
Options:
  --add-dir <directories...>   Additional directories to allow tool access to
  --agent <agent>              Agent for the current session...
  -p, --print                  Print response and exit (useful for pipes)...

Commands:
  install    Install Claude Code native build
  mcp        Configure and manage MCP servers
```

**打上 claude-zh 之后：**

```text
选项：
  --add-dir <directories...>   额外允许工具访问的目录
  --agent <agent>              当前会话使用的 Agent，会覆盖 'agent' 设置
  -p, --print                  打印响应后退出（适合管道场景）...

命令：
  install    安装 Claude Code 原生版本
  mcp        配置与管理 MCP 服务器
```

斜杠菜单 `/`、子命令、`--flag` help、skill 描述全部中文化，共 **324** 条翻译（covers Claude Code v2.1.118）。

---

## 30 秒上手

```bash
# 前提：官方 claude 已装 (npm i -g @anthropic-ai/claude-code)
npm install -g claude-zh
claude-zh patch
```

新开一个终端跑 `claude` 验证。回滚：`claude-zh unpatch`。

---

## 为什么要这个

Claude Code 里加 `"language": "中文"` 只会让**模型的回复**变中文，**CLI 自身界面**（`--help`、斜杠菜单、选项说明）仍然是英文。

claude-zh 补上这一块：所有用户**看得到**的界面文本都翻译，所有模型**用得到**的 tool 描述按你的策略来（默认全翻，出于保守理由要保留英文，把对应条目的 `zh` 置空即可）。

---

## 核心特性

- **精确** —— Babel AST 逐条字面量定位，按字节偏移切片替换
- **安全可逆** —— `.en.bak` 备份一旦建立就不覆写，`claude-zh unpatch` 随时一键回滚到纯英文
- **幂等** —— `patch` 可反复跑，每次都从 `.en.bak` 抽净英文，不会把已汉化的当英文再翻一轮
- **跟得上升级** —— claude 升版后再跑一次 `patch`，老字典按 `(kind, name, en)` 三层回退自动迁移到新字节偏移
- **零运行时开销** —— 替换发生在打包好的 JS 字面量层面，执行路径不加任何包装
- **不联网** —— 所有操作本地完成，不上传任何数据

---

## 常用命令

| 命令                         | 作用                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `claude-zh patch`            | 打汉化补丁（幂等）                                             |
| `claude-zh unpatch`          | 撤销补丁，回滚英文版                                           |
| `claude-zh status`           | 查看当前补丁状态、claude 版本、已翻条数                        |
| `claude-zh scan [--force]`   | 扫描当前 bundle 生成 `translations/<version>.json` 模板        |
| `claude-zh doctor`           | 环境自检（Node、codesign、otool、claude、字典）                |

---

## 工作原理

Claude Code 是 Bun `bun build --compile` 打的单文件可执行。13 MB 的 JS bundle 明文躺在 Mach-O 的 `__BUN` 段里，bundle 起点有 magic `// @bun @bytecode @bun-cjs`。

本工具做的事：

1. 从 `.en.bak`（首次 `patch` 时自动创建）抽干净英文 bundle
2. Babel AST 扫描，精确定位 6 类用户可见字符串：
   - `cli.programDescription` · `option.help` · `subcmd.description`
   - `slash.description` · `slash.argumentHint` · `skill.description`
3. 按每条的 `start` / `end` 字节偏移做字面量切片替换（支持 `StringLiteral` 和 `TemplateLiteral`，后者保留 `${...}` 表达式不变）
4. 改后 bundle 用空格右补齐到原长度，写回 `__BUN` 段内**所有** bundle 副本位置（动态检测，通常 2 份）
5. `codesign --force --sign -` 重新 ad-hoc 签名

所有动作在 `.en.bak` 副本上验证，原文件最后一步才原子替换（`rename(2)`）。任何一步失败立即 throw，不留中间态。

---

## 翻译字典

每个 claude 版本一份：`translations/<version>.json`。典型条目：

```json
{
  "id": "slash.description:add-dir",
  "kind": "slash.description",
  "name": "add-dir",
  "type": "local-jsx",
  "start": 3875906,
  "end": 3875935,
  "en": "Add a new working directory",
  "zh": "添加一个新的工作目录"
}
```

`isTemplate: true` 的条目是 JS 模板字面量，`en` / `zh` 必须保留首尾反引号和 `${...}` 原样：

```json
{
  "en": "`Toggle fast mode (${wE} only)`",
  "zh": "`切换快速模式（仅 ${wE}）`",
  "isTemplate": true
}
```

### 贡献翻译

只改 `zh` 字段就行。**不要动 `start` / `end` / `en` / `kind`** —— 这些是工具按当前 bundle 自动算出来的。

```bash
# 改完本地验证
claude-zh patch
claude --help       # 看效果
```

### 给新版本加字典

仓库没适配你本地 claude 版本时：

```bash
claude-zh scan
```

会在 `translations/` 下生成新版本文件，老字典里能匹配到的 `zh` 自动迁过来。新文件提 PR 就能贡献回去。

---

## 前置依赖

| 依赖              | 安装                                          |
| ----------------- | --------------------------------------------- |
| macOS arm64       | —                                             |
| Node.js >= 18     | —                                             |
| Xcode CLI Tools   | `xcode-select --install`（给 `codesign` / `otool`） |
| Claude Code       | `npm i -g @anthropic-ai/claude-code`          |

---

## 已知限制

- **只支持 macOS arm64**。x86_64 没测；Linux 不是 Mach-O，需要重写段定位逻辑。
- **字典滞后于新版**：claude 升级但仓库未同步字典时，新增命令保留英文（老字典能匹配到的翻译会自动迁过来）。
- **二进制缩小约 1 MB**：首次 `patch` 后 Anthropic 开发者签名被换成 ad-hoc 签名，文件体积变小。功能正常，预期行为。

---

## ⚠ 风险与法律

Claude Code 是 [Anthropic 专有软件](https://code.claude.com/docs/en/legal-and-compliance)：

- 工具**不分发** Anthropic 二进制。每位用户在自己机器上从自己装的官方 `claude` 抽字节、改自己的副本，工具只提供自动化流程
- 翻译字典是纯文本，不含 Anthropic 代码
- 个人本地自用风险较低，严格讲仍是灰区（修改了二进制内容）
- **出问题先 `claude-zh unpatch` 回滚再排查**，不要找 Anthropic 报 bug
- 未来 Anthropic 若加二进制完整性校验，本方案就失效

---

## License

MIT —— 仅涵盖本工具代码与翻译字典。Claude Code 二进制本身归 Anthropic 所有。
