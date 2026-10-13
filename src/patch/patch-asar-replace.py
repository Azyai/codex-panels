#!/usr/bin/env python3
"""替换 asar 内部的一个文件并重建整个 asar(用于给桌面端 webview 打轮询补丁)。

流程:读原 asar 全部条目 → 用新内容替换目标文件(重算其 integrity)
     → 按原顺序重排数据区、更新全部 offset → 写新 asar。
随后需重跑 patch-binary-hash.py(头部 JSON 哈希变了)。

用法:python patch-asar-replace.py <asar> <内部路径> <新内容文件> [输出路径]
"""
import struct
import json
import os
import sys
import hashlib

U32 = struct.Struct('<I')


def make_integrity(data, template):
    block_size = int(template.get('blockSize', 4 * 1024 * 1024))
    blocks = []
    for i in range(0, len(data), block_size):
        blocks.append(hashlib.sha256(data[i:i + block_size]).hexdigest())
    if not blocks:
        blocks = [hashlib.sha256(b'').hexdigest()]
    return {
        'algorithm': 'SHA256',
        'hash': hashlib.sha256(data).hexdigest(),
        'size': len(data),
        'blockSize': block_size,
        'blocks': blocks,
    }


def main():
    asar_path, internal, new_file = sys.argv[1], sys.argv[2], sys.argv[3]
    out_path = sys.argv[4] if len(sys.argv) > 4 else asar_path

    with open(asar_path, 'rb') as f:
        head = f.read(16)
        h1 = U32.unpack(head[4:8])[0]
        json_len = U32.unpack(head[12:16])[0]
        root = json.loads(f.read(json_len))
        data_base = 8 + h1

        entries = []

        def walk(node, prefix):
            for name, e in node.get('files', {}).items():
                p = (prefix + '/' + name) if prefix else name
                if 'files' in e:
                    walk(e, p)
                else:
                    entries.append((p, e))
        walk(root, '')

        blobs = {}
        for p, e in entries:
            if 'offset' in e:
                f.seek(data_base + int(e['offset']))
                blobs[p] = f.read(e['size'])

    with open(new_file, 'rb') as nf:
        blobs[internal] = nf.read()
    if internal not in blobs:
        raise SystemExit('内部路径不存在: ' + internal)

    new_data = bytearray()
    for p, e in entries:
        if 'offset' not in e:
            continue  # unpacked 文件存在 app.asar.unpacked 目录,不在数据区内
        blob = blobs[p]
        if p == internal and 'integrity' in e:
            e['integrity'] = make_integrity(blob, e['integrity'])
        e['offset'] = str(len(new_data))
        e['size'] = len(blob)
        new_data.extend(blob)

    new_json = json.dumps(root, separators=(',', ':')).encode('utf-8')
    new_h1 = (8 + len(new_json) + 3) & ~3
    pad = new_h1 - 8 - len(new_json)
    with open(out_path, 'wb') as out:
        out.write(U32.pack(4) + U32.pack(new_h1) + U32.pack(new_h1 - 4) + U32.pack(len(new_json)))
        out.write(new_json + b'\x00' * pad)
        out.write(new_data)
    print('重建完成:', out_path, '数据区 %.1f MB' % (len(new_data) / 1048576))
    print('记得重跑 patch-binary-hash.py 更新 exe 内的头部哈希!')


if __name__ == '__main__':
    main()
