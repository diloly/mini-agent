/**
 * 子进程执行层：以参数数组 spawn 一个受支持的技能脚本，并归一化输出与退出原因。
 *
 * 三条硬边界（缺一不可，来自设计 §2.8 / §2.9 / §2.11）：
 * - **参数数组 + shell:false**：绝无命令行字符串拼接，故无 shell 注入面。
 *   ⚠️ 唯一例外是 `.bat` / `.cmd` —— cmd.exe 会二次解析命令行，故这两类改由
 *   `interpreter.ts` 的 `buildScriptArgv` 自行引号化，并**拒绝**含 cmd 元字符的参数；
 * - **env 白名单重建**：绝不透传 process.env（主进程 env 可能含 API Key / safeStorage 状态）；
 * - **杀进程必须杀树**：Windows 上 child.kill() 只杀直接子进程，孙进程会残留 —— 用 taskkill /T /F。
 *
 * 本模块**不含 electron**（纯逻辑）：runtime 路径由调用方经注入的 resolver 取得后传入。
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { resolveBashExe, resolveNodeExe, resolveWindowsDir, type InterpreterKind } from './interpreter';

/** 单次工具调用的执行上限：普通脚本 <5 秒，30 秒给足余量又能及时止损（见设计 §5）。 */
export const RUN_TIMEOUT_MS = 30_000;
/** stdout + stderr **合计**输出上限（沿用 list_dir / search_text 的 8000 字符纪律）。 */
export const OUTPUT_LIMIT_CHARS = 8_000;
/** taskkill 之后的兜底等待：超过它仍未收到 close，就强杀并强制收尾（防句柄泄漏 / 永久挂起）。 */
const KILL_GRACE_MS = 5_000;

export interface RunProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  outputLimitChars: number;
  signal: AbortSignal;
  /**
   * 透传给 Node 的 `windowsVerbatimArguments`：true 时**不由 Node 引号化**参数，原样拼给子进程。
   * 仅 `.bat` / `.cmd` 需要（cmd.exe 会二次解析命令行，参数已在 interpreter.ts 的
   * `buildScriptArgv` 里自行引号化）。非 Windows 平台该选项被 Node 忽略。
   */
  verbatimArgs: boolean;
}

export type RunOutcome = 'exited' | 'timeout' | 'aborted' | 'spawn-error';

export interface RunProcessResult {
  outcome: RunOutcome;
  /** outcome==='exited' 时非 null */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 累计输出是否超过上限（stdout / stderr 分开标记） */
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  elapsedMs: number;
  /** outcome==='spawn-error' 时的原因（如 ENOENT / EACCES） */
  errorText?: string;
}

/**
 * 允许透传的基础环境变量白名单（取不到的键跳过）。
 * 🔴 绝不 `{ ...process.env }`：主进程 env 含 safeStorage 相关状态与可能的 API Key，
 *    整体透传等于把凭据交给第三方技能脚本（技能由用户导入、参数可由模型影响）。
 *
 * 刻意**排除**（务必写清，防后人「顺手补上」）：
 * - `APPDATA` / `USERPROFILE` / `HOME` / `LOCALAPPDATA`：不默认授予「家目录在哪」；
 * - `ComSpec`：不给 shell 句柄 → 脚本再套一层 shell（如 Python `subprocess(shell=True)`）会失败，**有意为之**
 *   （应用自己执行 `.bat` 时直接用绝对路径 spawn `cmd.exe`，并不依赖子进程的 `ComSpec`）；
 * - 系统 `PATH` / `Path`：`.py` / `.js` 只给运行时自身目录；`.exe` / `.bat` / `.cmd` / `.ps1` / `.sh`
 *   追加 Windows 系统目录（用户 2026-10-13 拍板），但**仍不含用户 PATH**；
 * - `NODE_OPTIONS`：不给脚本注入启动选项的口子；
 * - 任何 `*_KEY` / `*_TOKEN` / `*_SECRET` / `DEEPSEEK_*` / `SUPABASE_*`：**核心目标**，allowlist 天然覆盖；
 * - 其余 `ELECTRON_*`：避免泄漏主进程内部状态（唯一例外是我们显式设的 `ELECTRON_RUN_AS_NODE`）。
 */
const ENV_BASE_ALLOWLIST = [
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
] as const;

/**
 * Windows 系统目录。按用户 2026-10-13 拍板，执行 `.exe` / `.bat` / `.cmd` / `.ps1` / `.sh` 时
 * 放开到子进程 PATH，让脚本内能调用 where / findstr / tar / powershell / taskkill 等系统自带命令。
 *
 * ⚠️ 刻意**只给系统目录**，不给用户 PATH —— 脚本调得到系统工具，但仍调不到用户自己装的
 *    node / git / npm 等（那属于另一层能力，未获授权）。
 */
function systemPathDirs(): string[] {
  const root = resolveWindowsDir();
  return [
    path.join(root, 'System32'),
    root,
    path.join(root, 'System32', 'Wbem'),
    path.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
  ];
}

/**
 * 白名单重建子进程环境变量（允许清单 + 显式覆盖，而非黑名单过滤）。
 *
 * - `PATH`：`.py` / `.js` 只给运行时自身目录（**刻意的能力收紧**，系统尚无审批/审计能力）；
 *   `.exe` / `.bat` / `.cmd` / `.ps1` / `.sh` 追加 Windows 系统目录（用户 2026-10-13 拍板），
 *   让脚本内能调 `where` / `findstr` / `tar` / `powershell` / `taskkill`。**任何分支都不给用户 PATH。**
 * - 仍然不给 `ComSpec`（脚本再套一层 shell 会失败，有意为之）。
 * - Python 追加 `PYTHON*`；Node 追加 `ELECTRON_RUN_AS_NODE=1` 让 Electron 二进制以纯 Node 模式运行。
 *
 * ⚠️ `.py` **不用 `-I`**（命令行前缀只有 `-B`，理由见 interpreter.ts），因此下面这些 `PYTHON*`
 *    变量**全部实际生效**：
 *    - `PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`：强制子进程 stdout/stderr 以 UTF-8 输出，与我们的
 *      `StringDecoder('utf8')` 匹配（否则中文 Windows 会按 cp936/GBK 输出，导致中文乱码）；
 *    - `PYTHONUNBUFFERED=1`：实时输出，避免超时前拿不到任何内容；
 *    - `PYTHONDONTWRITEBYTECODE=1`：不写 `__pycache__`（与命令行 `-B` 同效，双保险）；
 *    - `PYTHONNOUSERSITE=1`：不加载用户 site-packages（去掉 `-I` 后由它**真实生效**）。
 */
export function buildChildEnv(kind: InterpreterKind, runtimeRoot: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_BASE_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  if (kind === 'python') {
    const pyDir = path.join(runtimeRoot, 'python');
    // PATH 只含运行时自身目录：脚本能找到 python / pip 的 console 脚本，但找不到系统工具。
    env.PATH = [pyDir, path.join(pyDir, 'Scripts')].join(path.delimiter);
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUTF8 = '1';
    env.PYTHONUNBUFFERED = '1';
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.PYTHONNOUSERSITE = '1';
  } else if (kind === 'node') {
    // Node 目录 = Electron 二进制所在目录（复用 Electron 内置 Node）。
    env.PATH = path.dirname(resolveNodeExe());
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    // exec / cmd / powershell / bash：用户 2026-10-13 拍板「PATH 加系统目录」。
    const dirs: string[] = [];
    if (kind === 'bash') {
      // bash 借的是系统已装的 Git Bash / WSL：把它自身所在目录也给上，否则它找不到自己的辅助程序。
      const bash = resolveBashExe();
      if (bash !== null) {
        dirs.push(path.dirname(bash));
      }
    }
    dirs.push(...systemPathDirs());
    env.PATH = dirs.join(path.delimiter);
  }
  return env;
}

/**
 * 运行一个已就绪的脚本进程，返回归一化结果（**不抛异常**，失败一律进结果对象）。
 *
 * 收尾路径有三条，全部会 `await` 到子进程 `close`：
 * - 正常退出 → `outcome:'exited'`；
 * - `timeoutMs` 到点 → `taskkill /PID <pid> /T /F` → `outcome:'timeout'`；
 * - `signal` 中止 → 同一条树杀路径 → `outcome:'aborted'`。
 */
export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const startedAt = Date.now();

  return new Promise<RunProcessResult>((resolve) => {
    // ---- 累计输出：stdout / stderr 共享合计预算，各自标记是否被截断 ----
    let stdout = '';
    let stderr = '';
    let captured = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    /**
     * 把一段解码后的文本并入指定流。
     * 超出**合计**预算即**丢弃并标记截断**（不是杀进程）—— 脚本要照常跑完，只是我们不继续累计。
     */
    const append = (stream: 'stdout' | 'stderr', text: string): void => {
      if (text.length === 0) {
        return;
      }
      const remaining = options.outputLimitChars - captured;
      if (remaining <= 0) {
        // 已到上限：继续消费 data 事件（排空管道，避免写满阻塞子进程），但不再累计。
        if (stream === 'stdout') {
          stdoutTruncated = true;
        } else {
          stderrTruncated = true;
        }
        return;
      }
      if (text.length <= remaining) {
        if (stream === 'stdout') {
          stdout += text;
        } else {
          stderr += text;
        }
        captured += text.length;
        return;
      }
      // 本段越过上限：只取剩余部分，随后标记该流被截断。
      const kept = text.slice(0, remaining);
      if (stream === 'stdout') {
        stdout += kept;
        stdoutTruncated = true;
      } else {
        stderr += kept;
        stderrTruncated = true;
      }
      captured = options.outputLimitChars;
    };

    // ---- 提前中止：signal 已 aborted，无需 spawn（没有进程要杀） ----
    if (options.signal.aborted) {
      resolve({
        outcome: 'aborted',
        exitCode: null,
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }

    // ---- spawn：参数数组 + shell:false；`.bat` / `.cmd` 例外设 windowsVerbatimArguments（见 buildScriptArgv）；----
    //      stdio[0]='ignore' 让脚本读输入立刻 EOF，而不是挂到超时 ----
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsVerbatimArguments: options.verbatimArgs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false, // 留在本进程组，便于 taskkill /T 整棵树
    });

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let finished = false;
    let timedOut = false;
    let aborted = false;
    let spawnErrorText: string | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let killFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    /** 唯一的收尾出口：清定时器、卸监听、flush 解码器、resolve（幂等）。 */
    const finalize = (outcome: RunOutcome, code: number | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (timeoutTimer !== undefined) {
        clearTimeout(timeoutTimer);
      }
      if (killFallbackTimer !== undefined) {
        clearTimeout(killFallbackTimer);
      }
      options.signal.removeEventListener('abort', onAbort);
      // flush 解码器残留（多字节字符可能被切在 chunk 边界）。
      append('stdout', stdoutDecoder.end());
      append('stderr', stderrDecoder.end());
      const result: RunProcessResult = {
        outcome,
        exitCode: outcome === 'exited' ? code : null,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        elapsedMs: Date.now() - startedAt,
      };
      if (spawnErrorText !== undefined) {
        result.errorText = spawnErrorText;
      }
      resolve(result);
    };

    /** 杀整棵进程树。 */
    const killTree = (): void => {
      const pid = child.pid;
      if (typeof pid !== 'number') {
        // 进程都没起来（通常意味着 spawn 失败），没有可杀的目标。
        return;
      }
      if (process.platform === 'win32') {
        // 🔴 Windows 上 child.kill() 只杀直接子进程；必须 taskkill 杀整棵树。
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        // taskkill 自身若启动失败（极罕见）不能让未处理的 error 事件拖垮主进程 —— 交给下面的兜底定时器。
        killer.on('error', () => {
          /* 由 killFallbackTimer 兜底强制收尾 */
        });
      } else {
        // 非 Windows 分支：保留跨平台可编译性（本项目当前只出 Windows x64 包）。
        child.kill('SIGKILL');
      }
    };

    /**
     * 发起树杀并武装兜底定时器。
     * 兜底原因：taskkill 发出后，若子进程 `close` 事件迟迟不来（例如 taskkill 自身失败、进程处于
     * 不可中断状态），Promise 会**永久悬挂**，把 agent loop 卡死。故到点再补一刀 `SIGKILL` 并强制收尾。
     */
    const beginKillAndArmFallback = (): void => {
      killTree();
      if (killFallbackTimer === undefined) {
        killFallbackTimer = setTimeout(() => {
          child.kill('SIGKILL'); // 对已退出进程是 no-op；对残活进程是最后手段
          finalize(aborted ? 'aborted' : 'timeout', null);
        }, KILL_GRACE_MS);
      }
    };

    const onAbort = (): void => {
      aborted = true;
      beginKillAndArmFallback();
    };

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      beginKillAndArmFallback();
    }, options.timeoutMs);
    options.signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      append('stdout', stdoutDecoder.write(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      append('stderr', stderrDecoder.write(chunk));
    });

    child.on('error', (error: Error) => {
      // ENOENT / EACCES 等 spawn 失败：不抛异常，归一为 spawn-error。
      const code = (error as NodeJS.ErrnoException).code;
      spawnErrorText = `${code !== undefined ? code : 'SPAWN_ERROR'}：${error.message}`;
      finalize('spawn-error', null);
    });

    child.on('close', (code: number | null) => {
      const outcome: RunOutcome = aborted ? 'aborted' : timedOut ? 'timeout' : 'exited';
      finalize(outcome, code);
    });
  });
}
