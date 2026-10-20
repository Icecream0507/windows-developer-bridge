# Windows Developer Bridge (WDB)

[![Windows CI](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Icecream0507/windows-developer-bridge/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

把你的 Windows 电脑变成一个 **MCP 服务器**：ChatGPT、Claude 等 AI 可以远程在这台电脑上执行 PowerShell、读写文件、跑后台任务、操作交互式终端、打补丁改代码。

- 零依赖：只需要 Node.js 20+（安装脚本会自动装）
- 一条命令安装，自动建立 Cloudflare 隧道，无需公网 IP / 路由器设置
- OAuth 2.1 + 本机 PIN 授权：只有坐在这台电脑前的人才能批准连接
- 支持 Windows PowerShell 5.1 与 PowerShell 7，中文输出不乱码

---

## 1. 一键安装

在 **PowerShell** 里运行（不需要管理员）：

```powershell
irm https://raw.githubusercontent.com/Icecream0507/windows-developer-bridge/main/install.ps1 | iex
```

安装完成后会自动启动，并显示：

```
MCP 地址（填到 ChatGPT 等客户端）: https://xxxx-xxxx.trycloudflare.com/mcp   ← 已复制到剪贴板
授权 PIN（只在本机看，别发给别人）: 123456789
```

> **访问不了 GitHub？** 先打开代理软件的「系统代理」，或者指定代理运行：
> `irm https://raw.githubusercontent.com/Icecream0507/windows-developer-bridge/main/install.ps1 -Proxy http://127.0.0.1:7897 | iex`
> 安装时下载 Node/cloudflared 会自动使用本机常见代理端口（7897 / 7890 / 10809）。**隧道（cloudflared）只能直连 Cloudflare**，如果你的网络连不上，请打开代理软件的 **TUN / 虚拟网卡模式**（普通「系统代理」对它无效），可用 `wdb doctor` 检查。

安装脚本做了这些事：检查/安装 Node.js LTS → 下载程序到 `%LOCALAPPDATA%\WindowsDeveloperBridge\app` → 下载 cloudflared → 注册 `wdb` 命令 → 给 Claude Code / Codex 安装 Skill → 开启完全访问 → 执行 `wdb start`。

不想自动启动或想先保持锁定：运行前设置 `$env:WDB_NO_START=1` 或 `$env:WDB_LOCKED=1`。

## 2. 连接 ChatGPT（3 步）

1. ChatGPT → **设置 → 应用 / Apps & Connectors → 高级设置**，打开 **开发者模式**（Developer mode）。
2. 点 **创建 / 添加连接器**：名称随意（如 `Windows`），**MCP 服务器 URL** 粘贴上面的地址（以 `/mcp` 结尾），**认证方式选 OAuth**。
3. 浏览器弹出授权页 → 输入电脑上显示的 **PIN** → **批准授权**。

完成后在对话中启用这个连接器，试着说：「用 Windows 连接器看看我 C 盘还剩多少空间」。

> Quick Tunnel 的地址**每次 `wdb start` / `wdb restart` 都会变**，变了要在 ChatGPT 里把连接器 URL 改成新地址（`wdb url` 查看）。想要固定地址见[进阶](#进阶)。

## 3. 日常使用

### 以后怎么启动

安装时已经自动启动过一次。**重启电脑后**（或执行过 `wdb stop` 后），打开 PowerShell 运行：

```powershell
wdb start
```

1. 屏幕上会显示新的 **MCP 地址**（已复制到剪贴板）和 **PIN**。
2. 地址和上次不同时，到 ChatGPT 连接器设置里把 URL 换成新地址（PIN 不变，一般不用重新授权）。
3. 服务在后台运行，关掉 PowerShell 窗口也不影响；用 `wdb status` 随时查看。

> 提示 `wdb` 不是命令：新开一个终端窗口再试，或运行 `%LOCALAPPDATA%\WindowsDeveloperBridge\bin\wdb.cmd start`。

### 全部命令

| 命令 | 作用 |
|---|---|
| `wdb start` | 后台启动服务 + 隧道，打印 MCP 地址和 PIN（关掉终端也会继续运行） |
| `wdb status` | 查看是否在运行、地址、PIN、是否锁定 |
| `wdb stop` / `wdb restart` | 停止 / 重启 |
| `wdb url` / `wdb pin` / `wdb token` | 只显示 MCP 地址 / 授权 PIN / 静态 Bearer token |
| `wdb lock` / `wdb unlock` | 关闭 / 开启完全访问（锁定时 AI 只能查看状态） |
| `wdb logs [http\|tunnel] [-f]` | 查看日志 |
| `wdb doctor` | 检查运行环境 |
| `wdb mcp-config` | 打印本机 Claude Code / Codex / Cursor 的接入配置 |
| `wdb reset-auth` | 让所有已授权的客户端失效，重新生成 PIN 和 token |
| `wdb update` / `wdb uninstall [--purge]` | 更新 / 卸载 |

## 4. AI 能用的工具

| 类别 | 工具 | 说明 |
|---|---|---|
| 状态 | `bridge_status`、`audit_tail` | 主机信息、Shell/Git/Codex 是否可用、审计日志 |
| 命令 | `shell_exec` | 运行 PowerShell 并等待结果（UTF-8、真实退出码、超时杀整个进程树） |
| 后台任务 | `shell_start`、`shell_job_status`、`shell_job_list`、`shell_job_kill` | 开发服务器、长时间构建；可等待结束、分页读日志，服务重启后依然可查 |
| 交互终端 | `pty_start`、`pty_read`、`pty_write`、`pty_resize`、`pty_signal`、`pty_close`、`pty_list` | 真实 Windows ConPTY：Python REPL、ssh、需要回答问题的安装程序、TUI |
| 文件 | `fs_read`、`fs_write`、`fs_list`、`fs_stat`、`fs_manage` | 分页读取、原子写入、复制/移动/删除/链接 |
| 改代码 | `apply_patch` | 支持 Codex 的 `*** Begin Patch` 格式（无需 Git）和 git 统一 diff |
| Codex | `codex_thread_list`、`codex_thread_read`、`codex_thread_turns_list` | 读取本机 Codex CLI 的历史会话 |

详细参数见 [工具参考](skills/windows-developer-bridge/references/tools.md)，与原版 Mac Developer Bridge 的对照见[兼容矩阵](docs/compatibility-matrix.md)。

## 5. 作为 Skill 使用

仓库里的 [`skills/windows-developer-bridge`](skills/windows-developer-bridge/SKILL.md) 是一个 Agent Skill：教 AI 如何安装、启动、连接、排错 WDB，以及怎样用好这些工具。

- **Claude Code / Codex**：一键安装脚本已自动装到 `~/.claude/skills/` 和 `~/.codex/skills/`，直接对它说「帮我启动 Windows Bridge 并告诉我连接地址」即可。
- **手动安装 / 其他平台**：从 [Releases](https://github.com/Icecream0507/windows-developer-bridge/releases) 下载 `windows-developer-bridge-skill.zip`，解压到 `~/.claude/skills/` 或 `~/.codex/skills/`；claude.ai 可在 设置 → Capabilities → Skills 上传这个 zip。
- 自己打包：`powershell -File scripts\package-skill.ps1` → `dist\windows-developer-bridge-skill.zip`。

## 6. 安全须知

- 开启完全访问后，AI 以**你当前 Windows 用户的权限**执行命令和改文件，**没有沙箱**。
- 隧道地址是公网可访问的；连接必须通过 OAuth + 本机 PIN（或静态 token）。**PIN / token 不要发给任何人。**
- 不用的时候 `wdb stop` 或 `wdb lock`。`wdb lock` 会立即拒绝后续调用并结束正在运行的后台任务和终端。
- 审计日志只记录工具名、参数名和参数哈希，不记录命令内容或文件内容（`audit_tail` 查看）。

更多见 [SECURITY.md](SECURITY.md)。

## 7. 常见问题

| 现象 | 解决 |
|---|---|
| 工具返回 `FULL_ACCESS_LOCKED` | 运行 `wdb unlock` |
| ChatGPT 提示无法连接 / 404 / 530 | `wdb status` 看隧道是否在线；地址变了就 `wdb restart` 并更新连接器 URL（要带 `/mcp`） |
| 隧道一直连不上 | `wdb doctor` 看能否直连 Cloudflare；连不上就打开代理软件的 **TUN / 虚拟网卡模式**（cloudflared 不走系统代理），然后 `wdb restart`；`wdb logs tunnel` 看原因 |
| 授权页提示 PIN 错误 | 用电脑上 `wdb pin` 显示的 9 位数字；连续错 5 次需重新发起授权 |
| `wdb` 不是命令 | 新开一个终端；或直接运行 `%LOCALAPPDATA%\WindowsDeveloperBridge\bin\wdb.cmd` |
| 端口 8787 被占用 | `wdb start --port 8788` |
| 想撤销所有授权 | `wdb reset-auth`，然后在客户端删除并重新添加连接器 |

## 进阶

**配置文件** `%LOCALAPPDATA%\WindowsDeveloperBridge\config.env`（`KEY=VALUE`，改完 `wdb restart`）：

| 键 | 作用 |
|---|---|
| `WDB_HTTP_PORT` | 本地端口，默认 `8787` |
| `WDB_HTTP_TOKEN` | 静态 Bearer token（自动生成，`wdb token` 查看） |
| `WDB_PROXY` | 下载 cloudflared 时使用的代理，如 `http://127.0.0.1:7897`；`off` 表示不用 |
| `WDB_TUNNEL` | 设为 `none` 则只在本机提供服务 |
| `CLOUDFLARE_TUNNEL_TOKEN` + `WDB_HTTP_PUBLIC_URL` | 使用自己的 Cloudflare 命名隧道和固定域名（例如 `https://pc.example.com`），地址不再变化 |
| `WDB_POWERSHELL` | 指定 PowerShell 可执行文件 |
| `CODEX_BIN` | 指定 Codex CLI |

**不用隧道、本机直连**：`wdb start --local`，地址为 `http://127.0.0.1:8787/mcp`；本机的 Claude Code / Codex 更推荐 stdio 方式（`wdb mcp-config`）。

**手动运行**：`node mcp-http.mjs`（HTTP + OAuth）或 `node bridge.mjs`（stdio MCP）。

**开发与测试**：

```powershell
git clone https://github.com/Icecream0507/windows-developer-bridge.git
cd windows-developer-bridge
node --test                                           # 单元 + 集成测试（Windows 上会跑 PowerShell/ConPTY 用例）
node tests/e2e-remote.mjs https://xxx.trycloudflare.com --long   # 对运行中的实例做端到端验证
```

路线图见 [TODO.md](TODO.md)。Chrome 浏览器相关工具尚未移植。
