<div align="center">

# codex-panels

**给官方 Codex 桌面端加上终端、编辑器面板与 VS Code 双向会话同步的开源补丁**

**简体中文** | [English](README.en.md)

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
git clone https://github.com/Azyai/codex-panels
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

> 执行 `git clone https://github.com/Azyai/codex-panels; cd codex-panels; powershell -ExecutionPolicy Bypass -File install.ps1`,按提示完成即可。

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
