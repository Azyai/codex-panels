// codex-panels 注入入口(打进 asar 内,由 patch-asar.py 追加)。
// 职责:先加载用户目录里的主进程运行时,再原样链回 Codex 官方入口。
'use strict';
const path = require('path');
const fs = require('fs');

const HOME =
  process.env.CODEX_PANELS_HOME ||
  path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'codex-panels');

try {
  const runtimeEntry = path.join(HOME, 'runtime', 'main-runtime.cjs');
  console.log('[codex-panels] ext-loader 启动, HOME =', HOME);
  if (fs.existsSync(runtimeEntry)) {
    require(runtimeEntry);
  } else {
    console.warn('[codex-panels] 未找到运行时(不影响 Codex 正常启动):', runtimeEntry);
  }
} catch (err) {
  // 运行时任何错误都不应拖垮 Codex 本体
  console.error('[codex-panels] 运行时加载失败:', err);
}

// 链回官方入口(patch 前的 main 字段)
require('./.vite/build/early-bootstrap.js');
