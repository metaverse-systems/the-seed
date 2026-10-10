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

/** The message execSync puts on its error for a command that exits non-zero. */
export function commandFailedMessage(command: string, stderr: string): string {
  return stderr.length > 0
    ? `Command failed: ${command}\n${stderr}`
    : `Command failed: ${command}`;
}

/**
 * Formats a failed command's output exactly as recursive builds always have:
 * stderr, then stdout, then the message of the error execSync would have thrown.
 */
export function formatFailureOutput(command: string, stdout: string, stderr: string): string {
  return stderr + stdout + commandFailedMessage(command, stderr);
}

/**
 * Runs a shell command without blocking the event loop, capturing its output
 * in full.
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
export function runCommand(command: string, options: RunCommandOptions = {}): Promise<CommandResult> {
  const { cwd, env, signal } = options;
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  if (signal?.aborted) {
    return Promise.resolve({ exitCode: null, signal: null, stdout: "", stderr: "", killed: true });
  }

  if (!exitHookInstalled) {
    process.on("exit", killRegisteredGroups);
    exitHookInstalled = true;
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
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

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

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
