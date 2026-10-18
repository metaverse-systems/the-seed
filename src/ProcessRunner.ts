import fs from "fs";
import path from "path";
import { spawn, spawnSync } from "child_process";

/** The outcome of one command run by runCommand(). */
export interface CommandResult {
  /** Exit status, or null when the command was ended by a signal */
  exitCode: number | null;
  /** The signal that ended the command, if any */
  signal: NodeJS.Signals | null;
  /** Everything the command wrote to stdout */
  stdout: string;
  /** Everything the command wrote to stderr */
  stderr: string;
  /** true when runCommand itself terminated the command because the signal aborted */
  killed: boolean;
}

export interface RunCommandOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment for the command; the parent's environment when omitted */
  env?: NodeJS.ProcessEnv;
  /** Aborting this terminates the command and everything it started */
  signal?: AbortSignal;
  /** How long to wait after SIGTERM before sending SIGKILL (default 3000 ms) */
  killGraceMs?: number;
  /**
   * Stream mode: each chunk is passed on as it arrives and nothing is kept,
   * so the result's stdout and stderr are empty strings.
   */
  output?: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void };
}

const DEFAULT_KILL_GRACE_MS = 3000;

const isWindows = process.platform === "win32";

// Process groups (POSIX) or process IDs (Windows) of commands still running.
// The exit hook uses this so no build step outlives the tool.
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function terminate(pid: number, signal: NodeJS.Signals): void {
  if (isWindows) {
    // Windows has no process groups; taskkill /T walks the process tree.
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    // A negative PID addresses the whole group: the shell, make and every
    // compiler make started.
    process.kill(-pid, signal);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
  }
}

/**
 * Sends SIGKILL to every process group still registered. Installed as a
 * process exit hook; exported so it can be exercised directly.
 */
export function killRegisteredGroups(): void {
  for (const pid of liveGroups) {
    if (isWindows) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone
      }
    }
  }
  liveGroups.clear();
}

/** IDs of the process groups started by runCommand() that are still running. */
export function liveProcessGroups(): number[] {
  return Array.from(liveGroups);
}

/**
 * Writes a program and its arguments as one line for messages. Words made
 * only of plain characters are written as they are, any other word in single
 * quotes. The result is never run.
 */
export function formatCommand(program: string, args: string[]): string {
  const word = (w: string): string =>
    w === "" ? "''" : /^[A-Za-z0-9_./:=@%+,-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`;
  return [program, ...args].map(word).join(" ");
}

/**
 * Finds an executable program. A name containing a slash is checked as it
 * is; otherwise each non-empty entry of `envPath` (default: PATH) is searched
 * for the first regular file that can be executed. Returns null when none.
 */
export function findOnPath(name: string, envPath: string | undefined = process.env.PATH): string | null {
  const isExecutable = (candidate: string): boolean => {
    try {
      if (!fs.statSync(candidate).isFile()) return false;
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (name.includes("/")) {
    return isExecutable(name) ? name : null;
  }
  for (const entry of (envPath ?? "").split(path.delimiter)) {
    if (entry === "") continue;
    const candidate = path.join(entry, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The message for a command that exits non-zero: the command text, then its stderr. */
export function commandFailedMessage(command: string, stderr: string): string {
  return stderr.length > 0
    ? `Command failed: ${command}\n${stderr}`
    : `Command failed: ${command}`;
}

/**
 * Formats a failed command's output exactly as recursive builds always have:
 * stderr, then stdout, then the failed-command message.
 */
export function formatFailureOutput(command: string, stdout: string, stderr: string): string {
  return stderr + stdout + commandFailedMessage(command, stderr);
}

/**
 * Runs a program with an argument array, without a shell and without
 * blocking the event loop. Nothing in the arguments or environment is
 * interpreted. The output is captured in full, or passed on as it arrives
 * when `options.output` is given.
 *
 * The command runs in its own process group so that aborting `signal` can
 * stop it together with everything it started, and so that a terminal Ctrl+C
 * reaches only this tool, which then decides what to stop. On abort the group
 * gets SIGTERM, then SIGKILL after the grace period.
 *
 * The promise resolves once the command has closed its output, so every
 * process holding it has exited. It never rejects for a non-zero exit, only
 * when the command cannot be started.
 */
export function runCommand(program: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const { cwd, env, signal, output } = options;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", killed: true });
  }

  if (!exitHookInstalled) {
    process.on("exit", killRegisteredGroups);
    exitHookInstalled = true;
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWindows,
    });

    const pid = child.pid;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let killed = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    if (pid !== undefined) {
      liveGroups.add(pid);
    }

    const onAbort = () => {
      if (pid === undefined || killed) return;
      killed = true;
      terminate(pid, "SIGTERM");
      graceTimer = setTimeout(() => terminate(pid, "SIGKILL"), killGraceMs);
    };

    const finish = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (pid !== undefined) liveGroups.delete(pid);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      if (output) output.stdout(chunk);
      else stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (output) output.stderr(chunk);
      else stderrChunks.push(chunk);
    });

    child.on("error", (err) => {
      if (settled) return;
      finish();
      reject(err);
    });

    child.on("close", (code, closeSignal) => {
      if (settled) return;
      finish();
      resolve({
        exitCode: code,
        signal: closeSignal,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
        killed,
      });
    });

    signal?.addEventListener("abort", onAbort);
  });
}
