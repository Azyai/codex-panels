#!/usr/bin/env python3
"""从 Codex 的 app.asar 提取文件(逆向用)。

默认只提取逆向最常用的三个目录(.vite 主进程 bundle、native-menu-locales 菜单文案、webview 前端),
加 --all 提取全部(含 node_modules,约 550MB)。

用法:
  python extract-asar.py <app.asar> [输出目录=./asar-extract] [--all]
"""
import argparse
import json
import os
import struct

U32 = struct.Struct('<I')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('asar', help='app.asar 路径')
    ap.add_argument('out', nargs='?', default='./asar-extract', help='输出目录(默认 ./asar-extract)')
    ap.add_argument('--all', action='store_true', help='提取全部(含 node_modules)')
    ap.add_argument('--only', help='只提取指定的顶层目录(如 webview),比默认更快')
    args = ap.parse_args()

    with open(args.asar, 'rb') as f:
        head = f.read(16)
        h1 = U32.unpack(head[4:8])[0]
        json_len = U32.unpack(head[12:16])[0]
        root = json.loads(f.read(json_len))
        data_base = 8 + h1

        wanted = ['.vite', 'native-menu-locales', 'webview']
        if args.all:
            wanted = None  # 不限
        if args.only:
            wanted = [args.only]

        count, total = 0, 0

        def walk(node, prefix):
            nonlocal count, total
            for name, entry in node.get('files', {}).items():
                rel = (prefix + '/' + name) if prefix else name
                if 'files' in entry:
                    if wanted is None or rel in wanted or rel.startswith(tuple(w + '/' for w in wanted)):
                        os.makedirs(os.path.join(args.out, rel), exist_ok=True)
                        walk(entry, rel)
                else:
                    if wanted is None or rel in wanted or rel.startswith(tuple(w + '/' for w in wanted)) or rel == 'package.json':
                        if entry.get('unpacked'):
                            print('UNPACKED(跳过):', rel)
                            continue
                        f.seek(data_base + int(entry['offset']))
                        data = f.read(entry['size'])
                        dst = os.path.join(args.out, rel)
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        with open(dst, 'wb') as out:
                            out.write(data)
                        count += 1
                        total += len(data)

        walk(root, '')
        print('提取完成: %d 个文件, %.1f MB -> %s' % (count, total / 1024 / 1024, args.out))


if __name__ == '__main__':
    main()
