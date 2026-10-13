#!/usr/bin/env python3
"""给 Codex webview(官方扩展 / 桌面端 asar 提取件)打「会话列表原生轮询」补丁 v2。

v1 失败原因:注入点在 refreshRecentConversations,该方法可能从不被调用(被 catalog
模式或初始路径绕过),导致定时器从未启动。

v2:注入点改为 listRecentThreads(任何列表加载必经的原始数据获取器,首次调用即
启动定时器),且轮询调用用非 routine 模式({mode:'cp-sync'})绕过
"recentHistorySource!==live && routine 则跳过" 的闸门,并输出 [cp-poll] 日志。

用法:python patch-webview-poll.py <webview目录>\\assets
"""
import os
import sys

TARGET = 'async listRecentThreads({originators:e,cursor:t,limit:n,background:r=!1}){'
INJECT = (
    "if(!this.__cpSync){this.__cpSync=1;console.log('[cp-poll] timer start');"
    "setInterval(()=>{try{this.refreshRecentConversations({mode:'cp-sync'}).catch(()=>{})}catch(e){}},1000);}"
)


def patch_file(path):
    data = open(path, encoding='utf-8', errors='surrogatepass').read()
    if '__cpSync' in data:
        print('已打过补丁:', os.path.basename(path))
        return False
    idx = data.find(TARGET)
    if idx < 0:
        return False
    patched = data[: idx + len(TARGET)] + INJECT + data[idx + len(TARGET):]
    backup = path + '.orig-poll'
    if not os.path.exists(backup):
        with open(path, 'rb') as src, open(backup, 'wb') as dst:
            dst.write(src.read())
    open(path, 'w', encoding='utf-8', errors='surrogatepass').write(patched)
    print('已注入轮询补丁 v2:', os.path.basename(path))
    return True


def main():
    assets_dir = sys.argv[1]
    patched = 0
    for name in os.listdir(assets_dir):
        if name.endswith('.js'):
            if patch_file(os.path.join(assets_dir, name)):
                patched += 1
    if patched == 0:
        print('未找到可打补丁的文件(或均已打过)')
        sys.exit(1)


if __name__ == '__main__':
    main()
