<div align="center">

# codex-panels

**给官方 Codex 桌面端加上终端、编辑器面板与 VS Code 双向会话同步的开源补丁**

**简体中文** | [English](#english)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#)
[![Requires](https://img.shields.io/badge/Requires-Python%203%20·%20MS%20Store%20Codex-yellow.svg)](#-快速开始)

只发布补丁与注入代码,不分发任何官方二进制。

</div>

---

## ✨ 功能

| | 功能 | 说明 |
| --- | --- | --- |
| 🖥️ | **终端面板** | Codex 左侧栏一键打开 / 关闭官方终端,无需进菜单 |
| 📝 | **编辑器联动** | 一键打开原生 VS Code,工作区自动跟随当前项目;VS Code 内可一键切回 Codex |
| 🔄 | **双向会话同步** | 任意一边创建 / 继续会话,另一边 1~2 秒内无感出现 |
| 🎯 | **会话筛选** | 官方 Codex 侧栏内按「当前项目 / 其他项目 / 普通会话」多选筛选历史 |
| 💬 | **AI 对话** | VS Code 里直接用官方 Codex 插件或 `@codex` 参与者,模型、登录、额度全部复用 Codex 本体(含全部思考强度档位) |
| 📂 | **项目自动归属** | 会话按目录自动归属到 Codex 对应项目 |

## 🚀 快速开始

```powershell
git clone https://github.com/<你的用户名>/codex-panels
cd codex-panels
powershell -ExecutionPolicy Bypass -File install.ps1
```

**环境要求**:Windows 10 1809+ · Python 3 · Microsoft Store 版 Codex 桌面应用

- 安装脚本自动从本机复制一份可写副本并打补丁,**不改动官方原版**
- 装完用桌面快捷方式 **「Codex(面板扩展)」** 启动
- VS Code 需重载窗口一次加载扩展
- 卸载:`powershell -ExecutionPolicy Bypass -File uninstall.ps1`(-Purge 连用户数据一起清)

> **📄 官方 Codex 大版本更新后**:重跑 `install.ps1 -Force` 即可(补丁按内容特征定位,不怕偏移变化)。

<details>
<summary><b>🤖 一句话让任意智能体帮你安装</b></summary>

> 克隆本仓库后执行 `powershell -ExecutionPolicy Bypass -File install.ps1`,按提示完成即可。

</details>

## 📁 目录结构

```
src/
├── desktop/   注入进 Codex 桌面端的代码(loader / 主进程运行时 / 页面 preload / 聊天桥)
├── vscode/     VS Code 扩展(codex-chat:@codex 参与者、树视图实时会话列表)
└── patch/      补丁脚本(asar 手术 / 二进制哈希替换 / webview 轮询与筛选 / CSP 放行)
tools/          开发调试工具(CDP 测试、协议探测、asar 提取)
```

## ⚙️ 原理

从本机官方 Codex 复制一份可写副本,patch `app.asar`(入口指向扩展加载器,再链回官方入口),替换 ChatGPT.exe 内的完整性校验哈希,并给官方扩展的 webview 注入会话列表 1 秒轮询(双向同步的关键),同时放行其 CSP 使筛选元数据可拉取。**只发布补丁与注入代码,不分发任何官方二进制。**

## ⚠️ 已知边界

- 官方 Codex 大版本更新后需重跑 `install.ps1 -Force`
- 扩展副本与官方 Codex 共享用户数据,两者不能同时运行
- 属于非官方改造,自用为主

## 📄 许可

[MIT](LICENSE) —— 本仓库只发布补丁与注入代码,不含任何官方二进制;OpenAI Codex 及相关商标归其所有者。

---

<div align="center">

<a id="english"></a>

# codex-panels

**Open-source patches that add terminal & editor panels and bidirectional VS Code session sync to the official Codex desktop app**

[简体中文](#codex-panels) | **English**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](#)
[![Requires](https://img.shields.io/badge/Requires-Python%203%20·%20MS%20Store%20Codex-yellow.svg)](#-quick-start)

Patches and injection code only — no official binaries are distributed.

</div>

---

## ✨ Features

| | Feature | Description |
| --- | --- | --- |
| 🖥️ | **Terminal panel** | Toggle the official terminal from a rail button in Codex's sidebar |
| 📝 | **Editor integration** | One click opens native VS Code with the workspace following the active project; jump back to Codex just as easily |
| 🔄 | **Bidirectional session sync** | Create or continue a conversation on either side, and it shows up on the other within 1–2 seconds |
| 🎯 | **Conversation filter** | Multi-select filter in the official Codex sidebar: current project / other projects / plain conversations |
| 💬 | **AI chat** | Use the official Codex extension or the `@codex` participant in VS Code — models, login and quota all reuse the Codex desktop app (every reasoning-effort level included) |
| 📂 | **Project auto-assignment** | Conversations are automatically assigned to the matching Codex project by directory |

## 🚀 Quick Start

```powershell
git clone https://github.com/<your-username>/codex-panels
cd codex-panels
powershell -ExecutionPolicy Bypass -File install.ps1
```

**Requirements**: Windows 10 1809+ · Python 3 · the Microsoft Store version of the Codex desktop app

- The installer copies a writable local copy of the official app and patches it — **the original is never touched**
- Launch via the desktop shortcut **"Codex (panels)"**
- Reload the VS Code window once to pick up the extension
- Uninstall with `powershell -ExecutionPolicy Bypass -File uninstall.ps1` (add `-Purge` to also wipe user data)

> **📄 After an official Codex major update**: just re-run `install.ps1 -Force` (patches locate their targets by content, not offsets).

<details>
<summary><b>🤖 One-liner for any AI agent to install this for you</b></summary>

> Clone this repository, then run `powershell -ExecutionPolicy Bypass -File install.ps1` and follow the prompts.

</details>

## 📁 Project Layout

```
src/
├── desktop/   Code injected into the Codex desktop app (loader / main runtime / page preload / chat bridge)
├── vscode/     VS Code extension (codex-chat: @codex participant, live tree view of conversations)
└── patch/      Patch scripts (asar surgery / binary hash swap / webview polling & filter / CSP allowance)
tools/          Dev & debug tools (CDP testing, protocol probing, asar extraction)
```

## ⚙️ How It Works

The installer copies the official Codex app to a writable location, patches `app.asar` (entry redirected to a loader that chains back to the original), swaps the integrity hash inside ChatGPT.exe, and injects a 1-second list poll into the official extension's webview — the key to bidirectional sync — while also allowing its CSP to fetch filter metadata. **Only patches and injection code are published; no official binaries.**

## ⚠️ Known Limits

- Re-run `install.ps1 -Force` after an official Codex major update
- The patched copy shares user data with the official Codex app — don't run both at once
- This is an unofficial modification; primarily for personal use

## 📄 License

[MIT](LICENSE) — This repository ships patches and injection code only; OpenAI Codex and related trademarks belong to their respective owners.
