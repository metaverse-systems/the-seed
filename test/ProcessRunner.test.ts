import fs from "fs";
import path from "path";
import os from "os";
import {
  runCommand,
  formatFailureOutput,
  formatCommand,
  findOnPath,
  liveProcessGroups,
  killRegisteredGroups,
  capturedText,
} from "../src/ProcessRunner";
import { defined } from "./helpers/Defined";

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
      const result = await runCommand("sh", ["-c", "echo hello; echo oops 1>&2"]);
      expect(result.exitCode).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe("hello\n");
      expect(result.stderr).toBe("oops\n");
      expect(result.killed).toBe(false);
    });

    it("returns a non-zero exit code without rejecting", async () => {
      const result = await runCommand("sh", ["-c", "echo partial; exit 7"]);
      expect(result.exitCode).toBe(7);
      expect(result.stdout).toBe("partial\n");
      expect(result.killed).toBe(false);
    });

    it("captures output larger than 1 MiB in full", async () => {
      const result = await runCommand("sh", ["-c", "head -c 2000000 /dev/zero | tr '\\0' x"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBe(2000000);
    });
  });

  describe("cwd and env", () => {
    it("runs in the given cwd", async () => {
      const result = await runCommand("pwd", [], { cwd: tmpDir });
      expect(fs.realpathSync(result.stdout.trim())).toBe(fs.realpathSync(tmpDir));
    });

    it("passes the given env", async () => {
      const result = await runCommand("sh", ["-c", "echo \"$RUNNER_TEST_VALUE\""], {
        env: { ...process.env, RUNNER_TEST_VALUE: "from-env" },
      });
      expect(result.stdout).toBe("from-env\n");
    });
  });

  describe("formatFailureOutput", () => {
    it("joins stderr, stdout and the command-failed message", () => {
      expect(formatFailureOutput("make -j", "out\n", "err\n")).toBe(
        "err\n" + "out\n" + "Command failed: make -j\n" + "err\n"
      );
    });

    it("builds the failure text of a failed run with an exact expected string", async () => {
      const args = ["-c", "echo out; echo err 1>&2; exit 3"];
      const result = await runCommand("sh", args);
      expect(result.exitCode).toBe(3);
      expect(formatFailureOutput(formatCommand("sh", args), result.stdout, result.stderr)).toBe(
        "err\nout\nCommand failed: sh -c 'echo out; echo err 1>&2; exit 3'\nerr\n"
      );
    });

    it("omits the stderr tail of the message when the command wrote nothing to stderr", async () => {
      const args = ["-c", "echo only-out; exit 1"];
      const result = await runCommand("sh", args);
      expect(formatFailureOutput(formatCommand("sh", args), result.stdout, result.stderr)).toBe(
        "only-out\nCommand failed: sh -c 'echo only-out; exit 1'"
      );
    });
  });

  describe("literal arguments and environment", () => {
    it("passes arguments literally", async () => {
      const tricky = "a $HOME 'q' \"d\"; * b\nnext line";
      const result = await runCommand("printf", ["%s", tricky]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(tricky);
    });

    it("passes environment values literally", async () => {
      const tricky = "$HOME 'q' \"d\"; * \nx";
      const result = await runCommand("sh", ["-c", "printf %s \"$RUNNER_TEST_VALUE\""], {
        env: { ...process.env, RUNNER_TEST_VALUE: tricky },
      });
      expect(result.stdout).toBe(tricky);
    });
  });

  describe("stream mode", () => {
    it("forwards stdout and stderr chunks in arrival order and keeps nothing", async () => {
      const events: Array<[string, string]> = [];
      const script = "echo one; sleep 0.2; echo two 1>&2; sleep 0.2; echo three";
      const result = await runCommand("sh", ["-c", script], {
        output: {
          stdout: (chunk: Buffer) => events.push(["stdout", chunk.toString()]),
          stderr: (chunk: Buffer) => events.push(["stderr", chunk.toString()]),
        },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(events).toEqual([
        ["stdout", "one\n"],
        ["stderr", "two\n"],
        ["stdout", "three\n"],
      ]);
    });
  });

  describe("start errors", () => {
    it("rejects with ENOENT when the program does not exist", async () => {
      await expect(runCommand("no-such-program-for-the-seed-test", [])).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  describe("formatCommand", () => {
    it("writes plain words as they are", () => {
      expect(formatCommand("make", ["-j4", "--prefix=/a/b_c.d:e@f%g+h,i-j"])).toBe(
        "make -j4 --prefix=/a/b_c.d:e@f%g+h,i-j"
      );
    });

    it("single-quotes other words and escapes a single quote as '\\''", () => {
      expect(formatCommand("./configure", ["--prefix=/my prefix", "it's", "$HOME", "a;b"])).toBe(
        "./configure '--prefix=/my prefix' 'it'\\''s' '$HOME' 'a;b'"
      );
    });

    it("writes the empty word as ''", () => {
      expect(formatCommand("echo", [""])).toBe("echo ''");
    });

    it("writes a program with no arguments alone", () => {
      expect(formatCommand("make", [])).toBe("make");
    });
  });

  describe("findOnPath", () => {
    let binA: string;
    let binB: string;

    beforeEach(() => {
      binA = path.join(tmpDir, "a");
      binB = path.join(tmpDir, "b");
      fs.mkdirSync(binA);
      fs.mkdirSync(binB);
    });

    function makeFile(dir: string, name: string, mode: number): string {
      const file = path.join(dir, name);
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, mode);
      return file;
    }

    it("checks a name containing a slash as it is", () => {
      const file = makeFile(binA, "tool", 0o755);
      expect(findOnPath(file, "/nonexistent")).toBe(file);
      expect(findOnPath(path.join(binA, "missing"), binA)).toBeNull();
    });

    it("returns the first executable regular file on the path", () => {
      const first = makeFile(binA, "tool", 0o755);
      makeFile(binB, "tool", 0o755);
      expect(findOnPath("tool", [binA, binB].join(path.delimiter))).toBe(first);
    });

    it("skips non-executable files and directories", () => {
      makeFile(binA, "tool", 0o644);
      fs.mkdirSync(path.join(binA, "dir-tool"));
      fs.mkdirSync(path.join(binB, "dir-tool"));
      const good = makeFile(binB, "tool", 0o755);
      const envPath = [binA, binB].join(path.delimiter);
      expect(findOnPath("tool", envPath)).toBe(good);
      expect(findOnPath("dir-tool", envPath)).toBeNull();
    });

    it("ignores empty path entries", () => {
      const original = process.cwd();
      makeFile(binA, "tool", 0o755);
      process.chdir(binA);
      try {
        expect(findOnPath("tool", ["", ""].join(path.delimiter))).toBeNull();
        expect(findOnPath("tool", "")).toBeNull();
      } finally {
        process.chdir(original);
      }
    });

    it("returns null when nothing matches", () => {
      expect(findOnPath("tool", [binA, binB].join(path.delimiter))).toBeNull();
    });

    it("reads PATH when no path is given", () => {
      const file = makeFile(binA, "seed-path-tool", 0o755);
      const saved = process.env.PATH;
      process.env.PATH = binA;
      try {
        expect(findOnPath("seed-path-tool")).toBe(file);
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  describe("cancellation", () => {
    it("kills the whole process group when the signal aborts", async () => {
      const shellPidFile = path.join(tmpDir, "shell.pid");
      const bgPidFile = path.join(tmpDir, "bg.pid");
      const controller = new AbortController();

      const promise = runCommand(
        "sh",
        ["-c", `echo $$ > ${shellPidFile}; sleep 30 & echo $! > ${bgPidFile}; sleep 30; wait`],
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
        "sh",
        ["-c", `trap "" TERM; echo ready > ${readyFile}; sleep 30`],
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

      const result = await runCommand("touch", [marker], { signal: controller.signal });

      expect(result.killed).toBe(true);
      expect(result.exitCode).toBeNull();
      await sleep(100);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe("live group registry", () => {
    it("is empty after runs resolve, including failed and killed runs", async () => {
      await runCommand("true", []);
      await runCommand("sh", ["-c", "exit 4"]);
      const controller = new AbortController();
      const promise = runCommand("sleep", ["30"], { signal: controller.signal });
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
    const promise = runCommand("sleep", ["30"]);
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

// Choice where the contract leaves the helper open: capturedText(chunks: Buffer[], limit?: number): string
// turns the captured chunks into text; the limit defaults to buffer.constants.MAX_STRING_LENGTH and
// tests lower it. Over the limit it keeps the tail of the output and starts with
// "[<n> bytes of earlier output omitted]\n"; the kept tail is at most `limit` bytes long.
describe("capture guard", () => {
  const noticePattern = /^\[(\d+) bytes of earlier output omitted\]\n/;

  it("drops nothing under the limit", () => {
    const chunks = [Buffer.from("hello "), Buffer.from("world\n")];
    expect(capturedText(chunks, 1000)).toBe("hello world\n");
  });

  it("drops nothing at exactly the limit", () => {
    const text = "x".repeat(64);
    expect(capturedText([Buffer.from(text)], 64)).toBe(text);
  });

  it("returns an empty string for no output", () => {
    expect(capturedText([], 10)).toBe("");
  });

  it("keeps the tail and starts with the omitted-bytes line when over the limit", () => {
    const text = Array.from({ length: 200 }, (_, i) => "line " + i + "\n").join("");
    const chunks = [Buffer.from(text.slice(0, 700)), Buffer.from(text.slice(700, 1100)), Buffer.from(text.slice(1100))];

    const result = capturedText(chunks, 256);

    const match = noticePattern.exec(result);
    expect(match).not.toBeNull();
    const omitted = Number(defined(match, "notice match")[1]);
    const kept = result.slice(defined(match, "notice match")[0].length);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(256);
    expect(text.endsWith(kept)).toBe(true);
    expect(omitted + kept.length).toBe(text.length);
    expect(result.endsWith("line 199\n")).toBe(true);
  });

  it("handles one chunk much longer than the limit", () => {
    const text = "a".repeat(10_000) + "THE END";
    const result = capturedText([Buffer.from(text)], 100);
    const match = defined(noticePattern.exec(result), "notice match");
    expect(match).not.toBeNull();
    expect(result.endsWith("THE END")).toBe(true);
    expect(Number(match[1]) + (result.length - match[0].length)).toBe(text.length);
  });

  it("applies to a stream by itself: the default limit leaves ordinary output alone", () => {
    const text = "ordinary output\n".repeat(1000);
    expect(capturedText([Buffer.from(text)])).toBe(text);
  });
});
