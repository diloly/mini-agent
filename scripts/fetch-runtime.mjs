#!/usr/bin/env node
/**
 * 抓取内置 Python runtime（python-build-standalone 的 install_only_stripped）。
 *
 * 用途：把随应用分发的 CPython 解压到 resources/runtime/。现由 postinstall 自动调用
 *       （带 --optional，失败不影响 pnpm install），也可手动 `npm run fetch-runtime`。
 * 幂等：目标已存在即跳过（除非 --force）。
 * 三步：① 下载 .tar.gz；② 校验 SHA256；③ 用 tar -xzf 解压。
 * 运行：node scripts/fetch-runtime.mjs [--force] [--optional]
 *
 * --optional：失败时**不**以非 0 退出（仅打印警告）。用于挂 postinstall —— 运行时只影响
 *             `.py` 技能，不该让「联网失败」把整个 `pnpm install` 搞挂。
 *             打包（dist:win）刻意**不带**此参数：缺运行时必须硬失败。
 *
 * 仅使用 Node 内置能力（node:https / node:crypto / node:fs / node:child_process 等），
 * 不引入任何第三方依赖，也不改动 package.json 的依赖清单。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { get } from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

/** 固定版本：不使用 latest，保证「同一次抓取永远得到同一份字节」—— 可复现性要求。 */
const PYTHON_VERSION = '3.13.16';
const RELEASE_TAG = '20261009';
const ASSET_NAME = `cpython-${PYTHON_VERSION}+${RELEASE_TAG}-x86_64-pc-windows-msvc-install_only_stripped.tar.gz`;
/** 下载地址：https://github.com/astral-sh/python-build-standalone/releases/download/<TAG>/<ASSET> */
const ASSET_URL = `https://github.com/astral-sh/python-build-standalone/releases/download/${RELEASE_TAG}/${ASSET_NAME}`;
/**
 * 期望的 SHA256（官方 release 资产摘要，取自 GitHub REST API 的 asset.digest 字段）。
 * 校验失败即中止，绝不落盘半个 runtime。
 */
const ASSET_SHA256 = '3a7adfb69e3ff02a41ed38ac637808532b438ab3c8619af46ca5dbec5c1f5190';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'resources', 'runtime');
const PYTHON_EXE = path.join(RUNTIME_DIR, 'python', 'python.exe');

/**
 * 解析命令行参数。
 * @param {string[]} argv
 * @returns {{ force: boolean }}
 */
function parseArgs(argv) {
  const known = ['--force', '--optional'];
  const unknown = argv.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) {
    throw new Error(`未知参数：${unknown.join(' ')}（本脚本仅支持 --force / --optional）`);
  }
  return { force: argv.includes('--force') };
}

/**
 * 计算文件的 SHA256（十六进制）。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function sha256OfFile(filePath) {
  const buffer = await readFile(filePath);
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 下载 url 到 destPath，自动跟随最多 3 次重定向（GitHub release 会 302 到 CDN）。
 * @param {string} url
 * @param {string} destPath
 * @param {number} [redirectsLeft]
 * @returns {Promise<void>}
 */
function download(url, destPath, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`重定向次数过多（>3），放弃下载：${url}`));
          return;
        }
        resolve(download(new URL(location, url).toString(), destPath, redirectsLeft - 1));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`下载失败：HTTP ${status}（${url}）`));
        return;
      }
      const fileStream = createWriteStream(destPath);
      fileStream.on('error', reject);
      res.on('error', reject);
      fileStream.on('finish', () => fileStream.close(() => resolve()));
      res.pipe(fileStream);
    }).on('error', (error) => {
      reject(new Error(`网络请求失败：${error.message}（${url}）`));
    });
  });
}

/**
 * 用 tar -xzf 解压归档到 destDir（Windows 10 1803+ 自带 tar.exe）。
 * 参数以数组形式传入、不启 shell，杜绝命令注入。
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', destDir], {
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    const decoder = new StringDecoder('utf8');
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += decoder.write(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`无法启动 tar（需 Windows 10 1803+ 自带 tar.exe）：${error.message}`));
    });
    child.on('close', (code) => {
      stderr += decoder.end();
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`tar 解压失败（退出码 ${code}）：${stderr.trim() || '无错误输出'}`));
    });
  });
}

/** 主流程：下载 → 校验 → 解压（幂等，--force 时强制重来）。 */
async function main() {
  const { force } = parseArgs(process.argv.slice(2));

  if (existsSync(PYTHON_EXE) && !force) {
    console.log(`[fetch-runtime] 已存在，跳过：${PYTHON_EXE}`);
    console.log('[fetch-runtime] 如需重新抓取，请加 --force');
    return;
  }

  console.log(`[fetch-runtime] 资产：${ASSET_NAME}`);
  console.log(`[fetch-runtime] 来源：${ASSET_URL}`);

  await mkdir(RUNTIME_DIR, { recursive: true });
  const archivePath = path.join(os.tmpdir(), ASSET_NAME);

  // ① 下载（若临时归档已存在且哈希正确则复用，避免重复下载）
  let hasArchive = false;
  if (existsSync(archivePath)) {
    const cached = await sha256OfFile(archivePath);
    if (cached === ASSET_SHA256) {
      console.log('[fetch-runtime] 复用已校验的临时归档');
      hasArchive = true;
    } else {
      await rm(archivePath, { force: true });
    }
  }
  if (!hasArchive) {
    console.log('[fetch-runtime] 下载中…');
    await download(ASSET_URL, archivePath);
  }

  // ② 校验 SHA256（不匹配即中止，不写任何 runtime 文件）
  const actual = await sha256OfFile(archivePath);
  if (actual !== ASSET_SHA256) {
    throw new Error(
      `SHA256 校验失败，已中止（未写入 runtime）。\n` +
        `  期望：${ASSET_SHA256}\n  实际：${actual}\n` +
        `  请删除临时归档后重试：${archivePath}`,
    );
  }
  console.log('[fetch-runtime] SHA256 校验通过');

  // ③ 解压到 resources/runtime/（归档内顶层目录为 python/）
  if (force) {
    await rm(path.join(RUNTIME_DIR, 'python'), { recursive: true, force: true });
  }
  console.log('[fetch-runtime] 解压中…');
  await extractTarGz(archivePath, RUNTIME_DIR);
  await rm(archivePath, { force: true });

  if (!existsSync(PYTHON_EXE)) {
    throw new Error(`解压完成但未找到解释器：${PYTHON_EXE}（归档布局可能已变化）`);
  }
  console.log(`[fetch-runtime] 完成：${PYTHON_EXE}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  // 挂 postinstall 时带 --optional：运行时只影响 .py 技能（.js / .mjs / .cjs 走 Electron 内置 Node），
  // 不该让「联网失败」把整个 pnpm install 搞挂。刻意以 0 退出，但把影响面说清楚。
  if (process.argv.includes('--optional')) {
    console.warn(`[fetch-runtime] 已跳过（非致命）：${message}`);
    console.warn('[fetch-runtime] 影响面：仅 .py 技能暂不可用；.js / .mjs / .cjs 走内置 Node，不受影响。');
    console.warn('[fetch-runtime] 联网后补拉：npm run fetch-runtime');
    return;
  }
  console.error(`[fetch-runtime] 失败：${message}`);
  process.exitCode = 1;
});
