#!/usr/bin/env python3
"""codex-panels 的 asar 手术脚本。

对 Codex 桌面 App 副本的 app.asar 做最小改动:
  1. package.json 的 main 从 .vite/build/early-bootstrap.js 改为 ext-loader.cjs
  2. 在 asar 数据区末尾追加 ext-loader.cjs 与改写后的 package.json
  3. 重写 asar 头(原有文件的偏移全部保持不变,新文件接在数据区末尾)

原文件会先备份为 app.asar.orig,可用 --restore 还原。

用法:
  python patch-asar.py <app.asar 路径> <ext-loader.cjs 路径>
  python patch-asar.py <app.asar 路径> --restore
"""
import argparse
import hashlib
import json
import os
import struct
import sys

U32 = struct.Struct('<I')


def read_header(f):
    """解析 asar 头:返回 (header_size, json_len, 根对象, data 基准偏移)。"""
    f.seek(0)
    head = f.read(16)
    h1 = U32.unpack(head[4:8])[0]
    json_len = U32.unpack(head[12:16])[0]
    root = json.loads(f.read(json_len))
    return h1, json_len, root, 8 + h1


def make_integrity(data, template):
    """按 @electron/asar 的格式为新增文件计算 integrity;若原文件都没有该字段则返回 None。"""
    if template is None:
        return None
    out = dict(template)
    block_size = int(template.get('blockSize', 4 * 1024 * 1024))
    blocks = []
    for i in range(0, len(data), block_size):
        blocks.append(hashlib.sha256(data[i:i + block_size]).hexdigest())
    if not blocks:
        blocks = [hashlib.sha256(b'').hexdigest()]
    out.update({
        'algorithm': 'SHA256',
        'hash': hashlib.sha256(data).hexdigest(),
        'size': len(data),
        'blockSize': block_size,
        'blocks': blocks,
    })
    return out


def patch(asar_path, loader_path):
    orig_backup = asar_path + '.orig'
    if os.path.exists(orig_backup):
        print('已存在备份,跳过二次备份')
    else:
        with open(asar_path, 'rb') as src, open(orig_backup, 'wb') as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        print('原 asar 已备份 ->', orig_backup)

    with open(asar_path, 'rb+') as f:
        h1, json_len, root, data_base = read_header(f)
        files = root['files']

        # 读取原 package.json 并改 main
        pkg_entry = files['package.json']
        f.seek(data_base + int(pkg_entry['offset']))
        pkg = json.loads(f.read(pkg_entry['size']))
        old_main = pkg.get('main')
        pkg['main'] = 'ext-loader.cjs'
        new_pkg_bytes = json.dumps(pkg, indent=2).encode('utf-8')

        # 读取 loader 内容
        with open(loader_path, 'rb') as lf:
            loader_bytes = lf.read()

        # 原始数据区(从 data_base 到文件末尾,整体保留)
        f.seek(0, os.SEEK_END)
        total = f.tell()
        data_len = total - data_base

        # 新文件的偏移(相对数据区起点)
        new_pkg_offset = data_len
        loader_offset = data_len + len(new_pkg_bytes)

        # 更新目录树
        integrity_tpl = None
        for entry in files.values():
            if 'integrity' in entry:
                integrity_tpl = entry['integrity']
                break
        files['package.json'] = dict(pkg_entry)
        files['package.json']['offset'] = str(new_pkg_offset)
        files['package.json']['size'] = len(new_pkg_bytes)
        if integrity_tpl:
            files['package.json']['integrity'] = make_integrity(new_pkg_bytes, integrity_tpl)
        files['ext-loader.cjs'] = {'offset': str(loader_offset), 'size': len(loader_bytes)}
        if integrity_tpl:
            files['ext-loader.cjs']['integrity'] = make_integrity(loader_bytes, integrity_tpl)

        new_json = json.dumps(root, separators=(',', ':')).encode('utf-8')
        # 头部框架: [4][H1][H1-4][json_len][json][pad],数据区起点 = 8+H1
        new_h1 = (8 + len(new_json) + 3) & ~3
        pad = new_h1 - 8 - len(new_json)
        header_bytes = U32.pack(4) + U32.pack(new_h1) + U32.pack(new_h1 - 4) + U32.pack(len(new_json)) + new_json + b'\x00' * pad

        # 重写整个文件:新头 + 原数据区 + 新增两块
        f.seek(data_base)
        original_data = f.read(data_len)  # 542MB 读入内存;机器内存 32GB,可接受
        f.seek(0)
        f.write(header_bytes)
        f.write(original_data)
        f.write(new_pkg_bytes)
        f.write(loader_bytes)
        f.truncate()
        print('patch 完成: main %s -> ext-loader.cjs, 头部 %d -> %d 字节' % (old_main, 8 + h1, 8 + new_h1))

    verify(asar_path)


def find_sample_file(files):
    """递归找第一个带 offset 的文件条目,用于抽样校验。"""
    for entry in files.values():
        if 'offset' in entry:
            return entry
        if 'files' in entry:
            found = find_sample_file(entry['files'])
            if found:
                return found
    return None


def verify(asar_path):
    with open(asar_path, 'rb') as f:
        _, _, root, data_base = read_header(f)
        files = root['files']
        assert files['package.json']['size'] > 0
        f.seek(data_base + int(files['package.json']['offset']))
        pkg = json.loads(f.read(files['package.json']['size']))
        assert pkg['main'] == 'ext-loader.cjs', 'main 未生效'
        f.seek(data_base + int(files['ext-loader.cjs']['offset']))
        loader = f.read(files['ext-loader.cjs']['size'])
        assert b'early-bootstrap' in loader, 'loader 内容异常'
        # 校验一个原有文件仍然可读(递归抽样)
        some = find_sample_file(files)
        assert some is not None, '目录树里找不到文件'
        f.seek(data_base + int(some['offset']))
        data = f.read(some['size'])
        if 'integrity' in some:
            expect = some['integrity']['hash']
            got = hashlib.sha256(data).hexdigest()
            assert expect == got, '原有文件完整性校验失败'
        print('verify 通过: package.json / ext-loader.cjs / 原有文件抽样 均正常')


def restore(asar_path):
    orig_backup = asar_path + '.orig'
    if not os.path.exists(orig_backup):
        print('没有备份可还原')
        sys.exit(1)
    os.replace(orig_backup, asar_path)
    print('已还原原版 asar')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('asar', help='app.asar 路径')
    ap.add_argument('loader', nargs='?', help='ext-loader.cjs 路径')
    ap.add_argument('--restore', action='store_true', help='从 .orig 备份还原')
    args = ap.parse_args()
    if args.restore:
        restore(args.asar)
    elif args.loader:
        patch(args.asar, args.loader)
    else:
        ap.error('需要提供 loader 路径,或使用 --restore')
