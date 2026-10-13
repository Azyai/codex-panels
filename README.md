# codex-panels

给 **OpenAI Codex 桌面版**(Microsoft Store)加侧栏扩展按钮 + 双向会话同步的开源补丁项目。

**功能**

- Codex 左侧栏新增两个按钮:**终端**(打开/关闭官方终端面板)、**打开编辑器**(一键打开原生 VS Code,工作区自动跟随当前项目)
- AI 对话:VS Code 里用官方 Codex 插件或 `@codex` 参与者,**模型、登录、额度全部复用 Codex 本体**(含全部思考强度档位)
- **双向会话同步**:任意一边创建/继续会话,另一边 1~2 秒内无感出现
- 会话按目录自动归属 Codex 对应项目

**安装**

```powershell
git clone https://github.com/<你的用户名>/codex-panels
cd codex-panels
powershell -ExecutionPolicy Bypass -File install.ps1
```

要求:Windows 10 1809+、Python 3、Microsoft Store 版 Codex 桌面应用(自动从本机复制补丁副本,不动原版)。
装完用桌面快捷方式「Codex(面板扩展)」启动;VS Code 需重载窗口一次。
卸载:`powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-Purge]`。

**一句话让任意智能体安装**

> 克隆本仓库后执行 `powershell -ExecutionPolicy Bypass -File install.ps1`,按提示完成即可。

**目录结构**

```
src/
├── desktop/   注入进 Codex 桌面端的代码(loader / 主进程运行时 / 页面 preload / 聊天桥)
├── vscode/     VS Code 扩展(codex-chat:@codex 参与者、树视图实时会话列表)
└── patch/      补丁脚本(asar 手术 / 哈希替换 / webview 原生轮询)
tools/          开发调试工具(CDP 测试、协议探测、asar 提取)
```

**原理**

从本机官方 Codex 复制一份可写副本,patch `app.asar`(入口指向扩展加载器,再链回官方入口),替换 ChatGPT.exe 内的完整性校验哈希,并给官方 webview 注入会话列表 1 秒轮询(双向同步的关键)。只发布补丁与注入代码,不分发任何官方二进制。

**已知边界**

- 官方 Codex 大版本更新后需重跑 `install.ps1 -Force`(补丁脚本按内容定位,不怕偏移变化)
- 扩展副本与官方 Codex 共享用户数据,两者不能同时运行
- 属于非官方改造,自用为主

**许可**

[MIT](LICENSE) —— 本仓库只发布补丁与注入代码,不含任何官方二进制;OpenAI Codex 及相关商标归其所有者。
