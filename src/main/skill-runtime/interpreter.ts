/**
 * 解释器分派层：按脚本扩展名选择内置解释器（Python / Node），并校验运行时是否就绪。
 *
 * 本模块**不含 electron**：
 * - python 路径由**纯函数** `resolvePythonExe(runtimeRoot)` 从注入的 runtimeRoot 拼出；
 * - node 复用 Electron 二进制，但只经 Node 全局属性 `process.execPath`，不触任何 electron API。
 * 因此它可以被 tools-skill-run.ts / run-process.ts 直接 import 而不引入 electron 依赖。
 */
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as path from 'node:path';

export type InterpreterKind = 'python' | 'node' | 'exec' | 'cmd' | 'powershell' | 'bash';

export interface InterpreterSpec {
  kind: InterpreterKind;
  /** spawn 的 program */
  command: string;
  /** 紧跟 program 的前置参数（如 python 的 -B、cmd 的 /d /s /c） */
  prefixArgs: string[];
  /** 是否把脚本绝对路径作为第一个参数传给 program（`.exe` 自身即程序 ⇒ false） */
  passScriptPath: boolean;
  /**
   * 是否由 cmd.exe **二次解析**命令行（仅 `.bat` / `.cmd` ⇒ true）。
   * true 时 run-process 会设 spawn 的 `windowsVerbatimArguments: true`，即**不由 Node 引号化**，
   * 改由 `buildScriptArgv` 自行拼好（理由见该函数注释）。
   */
  verbatimArgs: boolean;
  /** 结果文案与错误文案里显示的中文类型名（文案单一来源，禁止在别处再写一份） */
  label: string;
}

/** 支持的文件类型（单一事实来源；工具 description 文案也从这里取）。 */
export const SUPPORTED_EXTENSIONS: readonly string[] = [
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.exe',
  '.bat',
  '.cmd',
  '.ps1',
  '.sh',
];

/**
 * Python 解释器绝对路径：纯函数、只做字符串拼接，**不** import electron。
 * 解压后的布局为 <runtimeRoot>/python/python.exe（见 scripts/fetch-runtime.mjs）。
 */
export function resolvePythonExe(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'python', 'python.exe');
}

/**
 * Node 可执行文件 = process.execPath（Electron 自身，以 `ELECTRON_RUN_AS_NODE` 模式运行）。
 * process.execPath 是 **Node 全局属性，不是 electron API** —— 故本模块引用它不产生 electron 依赖，
 * 这也正是它能待在「无 electron」模块里的原因。
 *
 * ⚠️ 该机制依赖 Electron 的 `runAsNode` fuse 保持**启用状态**：**不得**在 electron-builder.yml 的
 *    `electronFuses` 里设置 `runAsNode: false`（那会让 `ELECTRON_RUN_AS_NODE` 被忽略）。
 *    当前项目**未配置 `electronFuses`**，默认启用 —— 保持现状即可。
 *
 * 🟡 **未证事实（仅为推理，切勿当作已证结论引用）**：推理认为 `ELECTRON_RUN_AS_NODE=1` 会让
 *    Electron 二进制**跳过 app 入口、直接以 Node 模式启动**，因此**不会**走到主进程的单实例锁
 *    `requestSingleInstanceLock()` —— 推论是「运行脚本不会误拉起第二个应用实例、也不会误触单实例锁」。
 *    此结论**未经实测**；T-R06 验收时**必须实测一次**（脚本运行期间用任务管理器核对 Electron 进程数，
 *    并确认单实例锁行为符合预期），确认后方可改记为已证事实。
 *    **在此之前，任何文档与结论都不得把它当作已证事实引用。**
 */
export function resolveNodeExe(): string {
  return process.execPath;
}

/**
 * Windows 安装目录。拿不到环境变量时退回 `C:\Windows`。
 * 纯字符串读取，**不 import electron**，故本模块仍可在无 electron 环境下工作。
 */
export function resolveWindowsDir(): string {
  const root = process.env.SystemRoot ?? process.env.windir;
  return root !== undefined && root.length > 0 ? root : 'C:\\Windows';
}

/**
 * cmd.exe 绝对路径。优先用 ComSpec（系统给的权威值），否则拼 `%SystemRoot%\System32\cmd.exe`。
 * 走绝对路径而非依赖 PATH：`.bat` / `.cmd` 不能脱离终端启动，只能靠 cmd.exe 解释它们。
 */
export function resolveCmdExe(): string {
  const comspec = process.env.ComSpec;
  return comspec !== undefined && comspec.length > 0
    ? comspec
    : path.join(resolveWindowsDir(), 'System32', 'cmd.exe');
}

/** Windows PowerShell 绝对路径。不走 PATH，免得被同名程序顶掉。系统自带，无需随应用分发。 */
export function resolvePowerShellExe(): string {
  return path.join(resolveWindowsDir(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * bash 可执行文件路径；**找不到返回 null**。
 *
 * 🔴 本应用**不内置** bash（只内置了 Python 运行时），只能借用系统已装的：WSL 的
 * `System32\bash.exe`，或 Git for Windows 的 `bin\bash.exe`。找不到时由
 * `assertInterpreterExists` 产出「运行时缺失：Bash」的专门文案，**不静默失败**。
 */
export function resolveBashExe(): string | null {
  const candidates = [path.join(resolveWindowsDir(), 'System32', 'bash.exe')]; // WSL
  const programFiles = process.env.ProgramFiles;
  if (programFiles !== undefined && programFiles.length > 0) {
    candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
  }
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (programFilesX86 !== undefined && programFilesX86.length > 0) {
    candidates.push(path.join(programFilesX86, 'Git', 'bin', 'bash.exe'));
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData !== undefined && localAppData.length > 0) {
    candidates.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // 单个候选探测失败（权限等）不影响继续探测下一个候选
    }
  }
  return null;
}

/**
 * 按扩展名选择解释器；不支持时返回 null（调用方据此给「不支持类型」拒绝文案）。
 * 扩展名以路径最后一段为准、统一转小写比较（大小写不敏感）。
 *
 * - `.py` → 内置 CPython，前缀**仅** `-B`（不写 `__pycache__`，避免在技能目录里留下脏文件）。
 *   🔴 **刻意不用 `-I`**（isolated），两条代价都不可接受：
 *   ① `-I` 隐含 `-E`（忽略所有 `PYTHON*` 环境变量）⇒ 我们设的 `PYTHONUTF8` / `PYTHONIOENCODING`
 *      **全部失效**；而 stdout 为**管道（非 tty）**时 Python 用 **locale 编码**输出（中文 Windows =
 *      cp936/GBK），与我们的 `StringDecoder('utf8')` 不匹配 ⇒ 脚本 `print("中文")` **必然乱码**；
 *   ② `-I` 在 Python 3.11+ 隐含 `-P`（不把脚本所在目录加入 `sys.path`）⇒ 技能脚本**无法 import
 *      同目录的辅助模块**，而「`scripts/main.py` + `scripts/utils.py`」正是技能包的典型结构。
 *   而 `-I` 想要的隔离我们另有**更可靠**的来源：`PYTHONPATH` 在 env 白名单里**压根不给**（`-E` 因此冗余）；
 *   用户 site 由 `PYTHONNOUSERSITE=1`（去掉 `-I` 后**真实生效**）关闭；越界由**双门守卫**拦截，
 *   与解释器参数无关。**故不得把 `-I` 加回来。**
 * - `.js` / `.mjs` / `.cjs` → 复用 Electron 内置 Node（以 `ELECTRON_RUN_AS_NODE` 模式运行），无前缀参数。
 * - `.exe` → 直接把程序本身作为 command（不再重复传脚本路径）。
 * - `.bat` / `.cmd` → 经 cmd.exe（`/d /s /c`）。cmd 会**二次解析**整条命令行，故由
 *   `buildScriptArgv` 自行引号化并加一层外壳引号，参数含 cmd 元字符时直接拒绝执行。
 * - `.ps1` → 系统自带 Windows PowerShell，加 `-ExecutionPolicy Bypass`（否则默认策略拒绝执行）。
 * - `.sh` → 借用**系统已装**的 bash（应用不内置）；找不到时 command 退化为 `'bash.exe'`，
 *   由 `assertInterpreterExists` 报「运行时缺失：Bash」，绝不静默失败。
 */
export function pickInterpreter(scriptAbsPath: string, runtimeRoot: string): InterpreterSpec | null {
  const ext = path.extname(scriptAbsPath).toLowerCase();
  if (ext === '.py') {
    return {
      kind: 'python',
      command: resolvePythonExe(runtimeRoot),
      prefixArgs: ['-B'],
      passScriptPath: true,
      verbatimArgs: false,
      label: 'Python',
    };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return {
      kind: 'node',
      command: resolveNodeExe(),
      prefixArgs: [],
      passScriptPath: true,
      verbatimArgs: false,
      label: 'Node',
    };
  }
  if (ext === '.exe') {
    // 可执行程序：程序本身就是脚本路径，不再额外传一次脚本参数。
    return {
      kind: 'exec',
      command: scriptAbsPath,
      prefixArgs: [],
      passScriptPath: false,
      verbatimArgs: false,
      label: '可执行程序',
    };
  }
  if (ext === '.bat' || ext === '.cmd') {
    // 批处理不能脱离终端启动 ⇒ 必须 cmd.exe /c；/d 关 AutoRun、/s 令引号处理确定化。
    // 命令行会被 cmd 二次解析，故 verbatimArgs=true，引号化改由 buildScriptArgv 负责。
    return {
      kind: 'cmd',
      command: resolveCmdExe(),
      prefixArgs: ['/d', '/s', '/c'],
      passScriptPath: true,
      verbatimArgs: true,
      label: 'Windows 批处理',
    };
  }
  if (ext === '.ps1') {
    // -ExecutionPolicy Bypass 是技能自带 .ps1 能跑起来的前提（默认策略会直接拒绝执行）。
    return {
      kind: 'powershell',
      command: resolvePowerShellExe(),
      prefixArgs: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'],
      passScriptPath: true,
      verbatimArgs: false,
      label: 'PowerShell',
    };
  }
  if (ext === '.sh') {
    // command 退化为 'bash.exe' 是刻意的：让 assertInterpreterExists 报「运行时缺失：Bash」，
    // 而不是让调用方误报成「不支持的文件类型」。
    return {
      kind: 'bash',
      command: resolveBashExe() ?? 'bash.exe',
      prefixArgs: [],
      passScriptPath: true,
      verbatimArgs: false,
      label: 'Bash',
    };
  }
  return null;
}

/** 会破坏 cmd.exe 命令行语义的字符：会被它当作命令分隔符、重定向或变量展开。 */
const CMD_UNSAFE_CHARS = ['"', '%', '!', '^', '&', '|', '<', '>', '(', ')', '\r', '\n'];

/** 无需引号即可安全直传的 token：不含空白，也不含上面的元字符。 */
const CMD_BARE_TOKEN = /^[A-Za-z0-9_\-./\\:=+,@#~\[\]{}]+$/;

/** 单个 token 的 cmd 引号化结果；含元字符时返回 null（调用方据此拒绝执行）。 */
function quoteCmdToken(token: string): string | null {
  for (const ch of CMD_UNSAFE_CHARS) {
    if (token.includes(ch)) {
      return null;
    }
  }
  if (token.length === 0) {
    return '""';
  }
  return CMD_BARE_TOKEN.test(token) ? token : `"${token}"`;
}

/**
 * 构造 program 之后要传的完整 argv。
 *
 * - 常规类型（`.py` / `.js` / `.mjs` / `.cjs` / `.exe` / `.ps1` / `.sh`）：
 *   `prefixArgs` (+ 脚本绝对路径) + 用户参数，由 Node（libuv）按 Windows 规则引号化，
 *   **不经过任何 shell**，因此用户参数没有注入面；
 * - `.bat` / `.cmd` 是**唯一例外**：cmd.exe 会把 `/c` 之后的整串再解析一遍，
 *   所以这里自行引号化、并把整串用**额外一对引号**包住（配合 `/s`，这是 cmd 的确定性用法：
 *   `cmd /d /s /c ""脚本" "参数""`）。任何含 cmd 元字符的参数**一律拒绝执行**，
 *   以免「参数数组 + shell:false」原本的零注入面被 cmd 的二次解析吃掉。
 */
export function buildScriptArgv(
  spec: InterpreterSpec,
  scriptAbsPath: string,
  args: readonly string[],
): { ok: true; args: string[] } | { ok: false; text: string } {
  if (!spec.passScriptPath) {
    return { ok: true, args: [...spec.prefixArgs, ...args] };
  }
  if (spec.kind !== 'cmd') {
    return { ok: true, args: [...spec.prefixArgs, scriptAbsPath, ...args] };
  }
  const tokens: string[] = [];
  for (const raw of [scriptAbsPath, ...args]) {
    const quoted = quoteCmdToken(raw);
    if (quoted === null) {
      return {
        ok: false,
        text:
          `参数不安全，已拒绝执行：批处理（.bat / .cmd）的参数不能包含这些字符：` +
          `${CMD_UNSAFE_CHARS.map((ch) => JSON.stringify(ch)).join(' ')}。` +
          `原因是 Windows 批处理必须由 cmd.exe 解释，这些字符会被它当成命令分隔符或变量展开` +
          `（这**不是**脚本自身的问题）。请改用不含这些字符的参数；` +
          `若参数确实必须包含它们，请把参数写进技能包内的配置文件，由脚本自己去读。`,
      };
    }
    tokens.push(quoted);
  }
  return { ok: true, args: [...spec.prefixArgs, `"${tokens.join(' ')}"`] };
}

/**
 * 解释器文件是否真的存在；缺失时给可读原因。
 *
 * ⚠️ 文案必须与「脚本不存在」**明确区分**并相互排除：这里缺的是**运行时**（打包时可能漏投
 * `resources/runtime/`），不是脚本本身 —— 否则模型会把「运行时没装」误报成「技能里没有这个脚本」。
 */
export async function assertInterpreterExists(
  spec: InterpreterSpec,
): Promise<{ ok: true } | { ok: false; text: string }> {
  if (spec.kind === 'exec') {
    // `.exe` 自身就是程序（调用方已校验过它存在），没有「解释器」可查。
    return { ok: true };
  }
  try {
    const info = await stat(spec.command);
    if (info.isFile()) {
      return { ok: true };
    }
  } catch {
    // 取不到信息一律落到下面的缺失文案；不存在与不可访问对调用方等价（都无法 spawn）。
  }
  if (spec.kind === 'bash') {
    return {
      ok: false,
      text:
        `运行时缺失：找不到 ${spec.label} 解释器（期望路径：${spec.command}）。这不是脚本的问题 —— ` +
        `脚本文件存在，缺的是运行时。本应用**不内置** bash，只能借用系统已装的：` +
        `WSL（C:\\Windows\\System32\\bash.exe）或 Git for Windows（%ProgramFiles%\\Git\\bin\\bash.exe）。` +
        `请装其一后重试；也可以改用技能内的 .py / .js / .exe 入口（它们分别由应用自带运行时或本身即程序）。`,
    };
  }
  if (spec.kind === 'cmd' || spec.kind === 'powershell') {
    return {
      ok: false,
      text:
        `运行时缺失：找不到 ${spec.label} 解释器（期望路径：${spec.command}）。这不是脚本的问题 —— ` +
        `脚本文件存在，缺的是运行时。${spec.label} 由 Windows 自带，正常安装的系统上一定存在，` +
        `缺失通常意味着系统目录被改动或环境变量异常（如 %SystemRoot% 指向了错误位置）。` +
        `请检查系统完整性后重试。`,
    };
  }
  return {
    ok: false,
    text:
      `运行时缺失：找不到内置 ${spec.label} 解释器（期望路径：${spec.command}）。这不是脚本的问题 —— ` +
      `脚本文件存在，缺的是运行时。通常意味着运行时未随应用分发（打包时可能漏了 resources/runtime/）。` +
      `请重新安装应用（从源码运行的开发者：在项目目录执行 npm run fetch-runtime 拉取运行时）；` +
      `若只需运行 .js / .mjs / .cjs 脚本，可改用内置 Node，无需额外下载。`,
  };
}
