/*
 * runInstallSteps with real processes. These cases live beside Dependencies.test.ts because that file
 * replaces child_process and the step runner.
 *
 * Choices where the contract is open:
 * - Steps are `sh -c` scripts; a step's command text in messages is formatCommand(program, args).
 * - "The process group is gone" is shown as in the step runner's own cases: the shell and a background
 *   child write their process IDs, and both are gone after the abort; no group is left registered.
 */
import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import { runInstallSteps } from "../src/Dependencies";
import { formatCommand, liveProcessGroups } from "../src/ProcessRunner";
import { BuildStep } from "../src/types";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(20);
  }
  return condition();
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

function shStep(label: string, script: string, extra: Partial<BuildStep> = {}, ...positional: string[]): BuildStep {
  return { label, program: "sh", args: ["-c", script, "sh", ...positional], ...extra };
}

function commandOf(step: BuildStep): string {
  return formatCommand(step.program, step.args);
}

describePosix("runInstallSteps", () => {
  let tmpDir: string;
  let logged: string[];
  let stdout: string;
  let stderr: string;
  const output = {
    stdout: (chunk: Buffer) => {
      stdout += chunk.toString();
    },
    stderr: (chunk: Buffer) => {
      stderr += chunk.toString();
    },
  };
  const log = (line: string) => {
    logged.push(line);
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-steps-test-"));
    logged = [];
    stdout = "";
    stderr = "";
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(liveProcessGroups()).toEqual([]);
  });

  it("runs every step in order from baseDir and resolves completed", async () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    const steps = [
      shStep("first", "echo one >> \"$1\"", { cwd: "sub" }, "order"),
      shStep("second", "echo two >> \"$1\"", { cwd: "sub" }, "order"),
    ];

    const result = await runInstallSteps(steps, { baseDir: tmpDir, output, log });

    expect(result).toEqual({ status: "completed" });
    expect(fs.readFileSync(path.join(tmpDir, "sub", "order"), "utf-8")).toBe("one\ntwo\n");
    expect(logged).toEqual(steps.map((step) => "==> " + step.label + ": " + commandOf(step)));
  });

  it("passes a failing step's output on both streams on and names the step", async () => {
    const failing = shStep("build lib", "echo to-out; echo to-err >&2; exit 4");
    const after = shStep("after", "touch \"$1\"", {}, path.join(tmpDir, "after-ran"));

    const result = await runInstallSteps([failing, after], { baseDir: tmpDir, output, log });

    expect(result).toEqual({ status: "failed", step: "build lib", message: commandOf(failing) + " exited with status 4" });
    expect(stdout).toBe("to-out\n");
    expect(stderr).toBe("to-err\n");
    expect(fs.existsSync(path.join(tmpDir, "after-ran"))).toBe(false);
    expect(logged).toEqual(["==> build lib: " + commandOf(failing)]);
  });

  it("names the step and the ending signal when a step is ended by a signal", async () => {
    const killed = shStep("killed", "kill -TERM $$");

    const result = await runInstallSteps([killed], { baseDir: tmpDir, output, log });

    expect(result).toEqual({ status: "failed", step: "killed", message: commandOf(killed) + " was ended by SIGTERM" });
  });

  it("fails with '<program>: not found' for a program that cannot be started", async () => {
    const missing: BuildStep = { label: "fetch", program: "the-seed-no-such-program", args: ["x"] };

    const result = await runInstallSteps([missing], { baseDir: tmpDir, output, log });

    expect(result).toEqual({ status: "failed", step: "fetch", message: "the-seed-no-such-program: not found" });
  });

  it("is cancelled and runs nothing when the signal is aborted before the first step", async () => {
    const controller = new AbortController();
    controller.abort();
    const marker = path.join(tmpDir, "ran");

    const result = await runInstallSteps([shStep("first", "touch \"$1\"", {}, marker)], {
      baseDir: tmpDir, output, log, signal: controller.signal,
    });

    expect(result).toEqual({ status: "cancelled" });
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("is cancelled during a step, stops its process group and starts no other step", async () => {
    const controller = new AbortController();
    const shellPid = path.join(tmpDir, "shell.pid");
    const bgPid = path.join(tmpDir, "bg.pid");
    const after = path.join(tmpDir, "after-ran");
    const promise = runInstallSteps([
      shStep("long", "echo $$ > \"$1\"; sleep 30 & echo $! > \"$2\"; wait", {}, shellPid, bgPid),
      shStep("after", "touch \"$1\"", {}, after),
    ], { baseDir: tmpDir, output, log, signal: controller.signal });
    const ready = () =>
      [shellPid, bgPid].every((file) => fs.existsSync(file) && fs.readFileSync(file, "utf-8").trim().length > 0);
    expect(await waitFor(ready)).toBe(true);
    const pids = [shellPid, bgPid].map((file) => Number(fs.readFileSync(file, "utf-8").trim()));

    controller.abort();

    expect(await promise).toEqual({ status: "cancelled" });
    for (const pid of pids) {
      expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
    }
    expect(fs.existsSync(after)).toBe(false);
  }, 10000);

  it("logs an ignoreExitCode step's failure as ignored and carries on", async () => {
    const after = path.join(tmpDir, "after-ran");
    const steps = [
      shStep("distclean", "exit 2", { ignoreExitCode: true }),
      shStep("after", "touch \"$1\"", {}, after),
    ];

    const result = await runInstallSteps(steps, { baseDir: tmpDir, output, log });

    expect(result).toEqual({ status: "completed" });
    expect(fs.existsSync(after)).toBe(true);
    expect(logged).toEqual([
      "==> distclean: " + commandOf(steps[0]),
      "distclean exited with status 2; ignored.",
      "==> after: " + commandOf(steps[1]),
    ]);
  });

  it("calls onStepStart before each step's heading with the 0-based index and the total", async () => {
    const events: string[] = [];
    const steps = [shStep("a", "true"), shStep("b", "true"), shStep("c", "true")];

    await runInstallSteps(steps, {
      baseDir: tmpDir,
      output,
      log: (line) => events.push("log " + line),
      onStepStart: (step, index, total) => events.push("start " + step.label + " " + index + "/" + total),
    });

    expect(events).toEqual([
      "start a 0/3", "log ==> a: " + commandOf(steps[0]),
      "start b 1/3", "log ==> b: " + commandOf(steps[1]),
      "start c 2/3", "log ==> c: " + commandOf(steps[2]),
    ]);
  });

  it("uses console.log and the tool's own streams when log and output are omitted", async () => {
    const lines: string[] = [];
    const written: string[] = [];
    const logSpy = jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      lines.push(util.format(...parts));
    });
    const writeSpy = jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write);
    const step = shStep("say", "echo hello");
    let result;
    try {
      result = await runInstallSteps([step], { baseDir: tmpDir });
    } finally {
      writeSpy.mockRestore();
      logSpy.mockRestore();
    }

    expect(result).toEqual({ status: "completed" });
    expect(lines).toEqual(["==> say: " + commandOf(step)]);
    expect(written.join("")).toBe("hello\n");
  });
});
