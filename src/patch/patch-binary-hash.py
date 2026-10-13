#!/usr/bin/env python3
"""codex-panels 的二进制完整性哈希替换脚本。

Owl 壳(Electron 分叉)在启动时用 asar_util 校验 app.asar 头部 JSON 的 SHA256,
期望值以 64 字符小写 hex 字符串的形式硬编码在 ChatGPT.exe 里。
本脚本把它替换成 patch 后 asar 的新哈希(等长替换,不影响其他字节)。

用法:
  python patch-binary-hash.py <app 目录> [--new-hash <hex>] [--restore]

默认行为:自动计算 <app>/resources/app.asar 的新 JSON 哈希并替换。
"""
import argparse
import hashlib
import json
import os
import struct

U32 = struct.Struct('<I')
HASH_LEN = 64


def asar_json_hash(asar_path):
    """按 Electron asar_util 的口径:头里 JSON 部分的 SHA256(hex 小写)。"""
    with open(asar_path, 'rb') as f:
        head = f.read(16)
        json_len = U32.unpack(head[12:16])[0]
        return hashlib.sha256(f.read(json_len)).hexdigest()


def find_hash_offset(exe_path, old_hash_hex):
    needle = old_hash_hex.encode('ascii')
    with open(exe_path, 'rb') as f:
        data = f.read()
    offsets = []
    pos = data.find(needle)
    while pos != -1:
        offsets.append(pos)
        pos = data.find(needle, pos + 1)
    return offsets


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('app_dir', help='Codex App 副本根目录(含 ChatGPT.exe 与 resources/app.asar)')
    ap.add_argument('--new-hash', help='新哈希(64 位 hex);缺省则自动从 app.asar 计算')
    ap.add_argument('--old-hash', help='旧哈希;缺省则自动从 app.asar.orig 备份计算')
    ap.add_argument('--restore', action='store_true', help='从 ChatGPT.exe.orig 还原')
    args = ap.parse_args()

    exe_path = os.path.join(args.app_dir, 'ChatGPT.exe')
    asar_path = os.path.join(args.app_dir, 'resources', 'app.asar')
    backup = exe_path + '.orig'

    if args.restore:
        os.replace(backup, exe_path)
        print('已还原', exe_path)
        return

    old_hash = args.old_hash
    if not old_hash:
        orig_asar = asar_path + '.orig'
        if os.path.exists(orig_asar):
            old_hash = asar_json_hash(orig_asar)
        else:
            old_hash = asar_json_hash(asar_path)
    new_hash = args.new_hash or asar_json_hash(asar_path)
    print('旧哈希:', old_hash)
    print('新哈希:', new_hash)
    assert len(old_hash) == HASH_LEN and len(new_hash) == HASH_LEN

    if old_hash == new_hash:
        print('哈希一致,无需替换')
        return

    offsets = find_hash_offset(exe_path, old_hash)
    if not offsets:
        # 之前打过补丁:exe 里已是别的哈希。从 exe 备份还原后再找一次。
        if os.path.exists(backup):
            os.replace(backup, exe_path)
            print('旧哈希未命中,已从 ChatGPT.exe.orig 还原后重试')
            offsets = find_hash_offset(exe_path, old_hash)
    if not offsets:
        raise SystemExit('在 ChatGPT.exe 中找不到旧哈希,无法替换')
    print('命中偏移:', [hex(o) for o in offsets])

    if not os.path.exists(backup):
        with open(exe_path, 'rb') as src, open(backup, 'wb') as dst:
            while True:
                chunk = src.read(1024 * 1024)
                if not chunk:
                    break
                dst.write(chunk)
        print('已备份 ChatGPT.exe ->', backup)

    with open(exe_path, 'rb+') as f:
        for offset in offsets:
            f.seek(offset)
            f.write(new_hash.encode('ascii'))
    print('替换完成,共 %d 处' % len(offsets))

    # 验证
    left = find_hash_offset(exe_path, old_hash)
    assert not left, '仍残留旧哈希'
    print('verify 通过: 二进制中已无旧哈希')


if __name__ == '__main__':
    main()
