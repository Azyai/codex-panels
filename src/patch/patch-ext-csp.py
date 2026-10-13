#!/usr/bin/env python3
"""给官方 Codex 扩展的宿主侧代码(out/extension.js)打 CSP 补丁。

背景:官方扩展给 webview 注入的 Content-Security-Policy 只允许
connect-src 'self' / vscode-cdn / sentry 等来源,webview 里的注入代码
无法 fetch http://127.0.0.1:8391(codex-panels 后端),导致会话筛选的
项目归属元数据拉不到。本补丁把后端地址追加进 connect-src 白名单。

用法:python patch-ext-csp.py <扩展根目录>   (即含 out/ 的目录)
"""
import os
import sys

TARGET = b'let n=[t,"blob:",r,R7t,...I7t,..._7t];'
REPLACEMENT = b'let n=[t,"blob:",r,R7t,...I7t,..._7t,"http://127.0.0.1:8391"];'
BACKEND = b'http://127.0.0.1:8391'


def main():
    ext_root = sys.argv[1]
    path = os.path.join(ext_root, 'out', 'extension.js')
    data = open(path, 'rb').read()
    if BACKEND + b'"];' in data and data.count(TARGET) == 0:
        print('已打过 CSP 补丁:', path)
        return
    count = data.count(TARGET)
    if count != 1:
        print('CSP 构建代码定位失败(出现 %d 次),跳过' % count)
        sys.exit(1)
    backup = path + '.orig-csp'
    if not os.path.exists(backup):
        with open(path, 'rb') as src, open(backup, 'wb') as dst:
            dst.write(src.read())
    patched = data.replace(TARGET, REPLACEMENT)
    with open(path, 'wb') as f:
        f.write(patched)
    print('已注入 CSP 补丁(connect-src + http://127.0.0.1:8391):', path)


if __name__ == '__main__':
    main()
