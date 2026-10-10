import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  runCommand,
  formatFailureOutput,
  liveProcessGroups,
  killRegisteredGroups,
} from "../src/ProcessRunner";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(filePath: string, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content.length > 0) return content;
    }
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw e;
  }
}

// A killed orphan is reaped by init shortly after it dies; allow for that.
async function waitUntilGone(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(20);
  }
  return !isAlive(pid);
}

describePosix("ProcessRunner", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(liveProcessGroups()).toEqual([]);
  });

  describe("exit status and output", () => {
    it("returns exit code 0 and captures stdout and stderr", async () => {
      const result = await runCommand("echo hello; echo oops 1>&2");
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("oops\n");
      expect(result.killed).toBe(false);
    });

    it("returns a non-zero exit code without rejecting", async () => {
      const result = await runCommand("echo partial; exit 7");
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("partial\n");
      expect(result.killed).toBe(false);
    });

    it("captures output larger than 1 MiB in full", async () => {
      const result = await runCommand("head -c 2000000 /dev/zero | tr '\\0' x");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(2000000);
    });
  });

  describe("cwd and env", () => {
    it("runs in the given cwd", async () => {
      const result = await runCommand("pwd", { cwd: tmpDir });
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(tmpDir));
    });

    it("passes the given env", async () => {
      const result = await runCommand("echo \"$RUNNER_TEST_VALUE\"", {
        env: { ...process.env, RUNNER_TEST_VALUE: "from-env" },
      });
      expect(result.stdout).toBe("from-env\n");
    });
  });

  describe("formatFailureOutput", () => {
    const command = "sh -c 'echo out; echo err 1>&2; exit 3'";

    it("joins stderr, stdout and the command-failed message", () => {
      expect(formatFailureOutput("make -j", "out\n", "err\n")).toBe(
        "err\n" + "out\n" + "Command failed: make -j\n" + "err\n"
      );
    });

    it("matches the text built from a caught execSync error", async () => {
      let expected = "";
      try {
        execSync(command, { stdio: "pipe" });
      } catch (e: unknown) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
        expected =
          (err.stderr?.toString() ?? "") +
          (err.stdout?.toString() ?? "") +
          (err.message ?? "");
      }
      expect(expected).not.toBe("");

      const result = await runCommand(command);
      expect(result.exitCode).toBe(3);
      expect(formatFailureOutput(command, result.stdout, result.stderr)).toBe(expected);
    });

    it("matches execSync when the command writes nothing to stderr", async () => {
      const quiet = "sh -c 'echo only-out; exit 1'";
      let expected = "";
      try {
        execSync(quiet, { stdio: "pipe" });
      } catch (e: unknown) {
        const err = e as { stderr?: Buffer; stdout?: Buffer; message?: string };
        expected =
          (err.stderr?.toString() ?? "") +
          (err.stdout?.toString() ?? "") +
          (err.message ?? "");
      }

      const result = await runCommand(quiet);
      expect(formatFailureOutput(quiet, result.stdout, result.stderr)).toBe(expected);
    });
  });

  describe("cancellation", () => {
    it("kills the whole process group when the signal aborts", async () => {
      const shellPidFile = path.join(tmpDir, "shell.pid");
      const bgPidFile = path.join(tmpDir, "bg.pid");
      const controller = new AbortController();

      const promise = runCommand(
        `echo $$ > ${shellPidFile}; sleep 30 & echo $! > ${bgPidFile}; sleep 30; wait`,
        { signal: controller.signal }
      );

      const shellPid = Number(await waitForFile(shellPidFile));
      const bgPid = Number(await waitForFile(bgPidFile));
      expect(isAlive(shellPid)).toBe(true);
      expect(isAlive(bgPid)).toBe(true);

      controller.abort();
      const result = await promise;

      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(await waitUntilGone(shellPid)).toBe(true);
      expect(await waitUntilGone(bgPid)).toBe(true);
    }, 10000);

    it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
      const readyFile = path.join(tmpDir, "ready");
      const controller = new AbortController();

      const promise = runCommand(
        `trap "" TERM; echo ready > ${readyFile}; sleep 30`,
        { signal: controller.signal, killGraceMs: 200 }
      );

      await waitForFile(readyFile);
      const abortedAt = Date.now();
      controller.abort();
      const result = await promise;

      expect(result.killed).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(150);
      expect(Date.now() - abortedAt).toBeLessThan(5000);
    }, 10000);

    it("does not spawn when the signal is already aborted", async () => {
      const marker = path.join(tmpDir, "spawned");
      const controller = new AbortController();
      controller.abort();

      const result = await runCommand(`touch ${marker}`, { signal: controller.signal });

      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
      await sleep(100);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe("live group registry", () => {
    it("is empty after runs resolve, including failed and killed runs", async () => {
      await runCommand("true");
      await runCommand("exit 4");
      const controller = new AbortController();
      const promise = runCommand("sleep 30", { signal: controller.signal });
      await sleep(50);
      expect(liveProcessGroups().length).toBe(1);
      controller.abort();
      await promise;
      expect(liveProcessGroups()).toEqual([]);
    }, 10000);
  });
});

describePosix("ProcessRunner exit hook", () => {
  it("kills every registered group and empties the registry", async () => {
    const promise = runCommand("sleep 30");
    for (let i = 0; i < 50 && liveProcessGroups().length === 0; i++) {
      await sleep(10);
    }
    const [pgid] = liveProcessGroups();
    expect(pgid).toBeDefined();

    killRegisteredGroups();
    const result = await promise;

    expect(result.signal).toBe("SIGKILL");
    expect(liveProcessGroups()).toEqual([]);
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      try {
        process.kill(-pgid, 0);
        await sleep(20);
      } catch {
        gone = true;
      }
    }
    expect(gone).toBe(true);
  }, 10000);
});
