import fs from "fs";
import os from "os";
import path from "path";
import { runStep, stepText, StepOutcome } from "../src/StepRunner";
import { formatCommand, formatFailureOutput, liveProcessGroups } from "../src/ProcessRunner";
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

function shStep(script: string, extra: Partial<BuildStep> = {}, ...positional: string[]): BuildStep {
  return { label: "test", program: "sh", args: ["-c", script, "sh", ...positional], ...extra };
}

describePosix("StepRunner", () => {
  let tmpDir: string;
  const capture = { mode: "capture" } as const;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "step-runner-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(liveProcessGroups()).toEqual([]);
  });

  it("gives interrupted and starts nothing when the signal is already aborted", async () => {
    const marker = path.join(tmpDir, "started");
    const controller = new AbortController();
    controller.abort();
    const outcome = await runStep(shStep("touch \"$1\"", {}, marker), {
      baseDir: tmpDir,
      output: capture,
      signal: controller.signal,
    });
    expect(outcome).toEqual({ status: "interrupted" });
    await sleep(100);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("resolves a relative step cwd against baseDir", async () => {
    fs.mkdirSync(path.join(tmpDir, "sub"));
    const outcome = await runStep(
      shStep("pwd > \"$1\"", { cwd: "sub" }, path.join(tmpDir, "cwd.txt")),
      { baseDir: tmpDir, output: capture }
    );
    expect(outcome).toEqual({ status: "completed" });
    const recorded = fs.readFileSync(path.join(tmpDir, "cwd.txt"), "utf-8").trim();
    expect(fs.realpathSync(recorded)).toBe(fs.realpathSync(path.join(tmpDir, "sub")));
  });

  it("runs in baseDir when the step has no cwd", async () => {
    await runStep(shStep("pwd > \"$1\"", {}, path.join(tmpDir, "cwd.txt")), {
      baseDir: tmpDir,
      output: capture,
    });
    const recorded = fs.readFileSync(path.join(tmpDir, "cwd.txt"), "utf-8").trim();
    expect(fs.realpathSync(recorded)).toBe(fs.realpathSync(tmpDir));
  });

  it("lays step.env over baseEnv", async () => {
    const out = path.join(tmpDir, "env.txt");
    const outcome = await runStep(
      shStep("printf \"%s|%s|%s\" \"$STEP_A\" \"$STEP_B\" \"$STEP_C\" > \"$1\"", { env: { STEP_B: "from-step" } }, out),
      {
        baseDir: tmpDir,
        baseEnv: { ...process.env, STEP_A: "base-a", STEP_B: "base-b" },
        output: capture,
      }
    );
    expect(outcome).toEqual({ status: "completed" });
    expect(fs.readFileSync(out, "utf-8")).toBe("base-a|from-step|");
  });

  it("gives completed for exit 0", async () => {
    expect(await runStep(shStep("exit 0"), { baseDir: tmpDir, output: capture })).toEqual({
      status: "completed",
    });
  });

  it("gives ignored with the exit code for a non-zero exit of an ignoreExitCode step", async () => {
    const outcome = await runStep(shStep("exit 5", { ignoreExitCode: true }), {
      baseDir: tmpDir,
      output: capture,
    });
    expect(outcome).toEqual({ status: "ignored", exitCode: 5 });
  });

  it("gives failed with the exit code and the failure text in capture mode", async () => {
    const step = shStep("echo out; echo err 1>&2; exit 3");
    const outcome = await runStep(step, { baseDir: tmpDir, output: capture });
    expect(outcome.status).toBe("failed");
    const failed = outcome as Extract<StepOutcome, { status: "failed" }>;
    expect(failed.exitCode).toBe(3);
    expect(failed.output).toBe(formatFailureOutput(stepText(step), "out\n", "err\n"));
  });

  it("gives failed with empty output in stream mode", async () => {
    const outcome = await runStep(shStep("echo out; exit 4"), {
      baseDir: tmpDir,
      output: { mode: "stream", output: { stdout: () => undefined, stderr: () => undefined } },
    });
    expect(outcome).toMatchObject({ status: "failed", exitCode: 4, output: "" });
  });

  it("gives notFound with '<program>: not found' for a missing program", async () => {
    const outcome = await runStep(
      { label: "x", program: "no-such-program-for-the-seed-test", args: [] },
      { baseDir: tmpDir, output: capture }
    );
    expect(outcome).toEqual({
      status: "notFound",
      message: "no-such-program-for-the-seed-test: not found",
    });
  });

  it("gives interrupted, never failed or ignored, when aborted during a run", async () => {
    const controller = new AbortController();
    const marker = path.join(tmpDir, "running");
    const promise = runStep(
      shStep("touch \"$1\"; sleep 30", { ignoreExitCode: true }, marker),
      { baseDir: tmpDir, output: capture, signal: controller.signal }
    );
    expect(await waitFor(() => fs.existsSync(marker))).toBe(true);
    controller.abort();
    expect(await promise).toEqual({ status: "interrupted" });
  }, 10000);

  it("stream mode delivers output before the step ends", async () => {
    const release = path.join(tmpDir, "release");
    let received = "";
    const promise = runStep(
      shStep("echo started; while [ ! -f \"$1\" ]; do sleep 0.02; done; echo finished", {}, release),
      {
        baseDir: tmpDir,
        output: {
          mode: "stream",
          output: {
            stdout: (chunk: Buffer) => {
              received += chunk.toString();
              if (received.includes("started")) fs.writeFileSync(release, "go");
            },
            stderr: () => undefined,
          },
        },
      }
    );
    const outcome = await promise;
    expect(outcome).toEqual({ status: "completed" });
    expect(received).toBe("started\nfinished\n");
  }, 10000);

  it("stream mode stops the process group on abort", async () => {
    const controller = new AbortController();
    const shellPid = path.join(tmpDir, "shell.pid");
    const bgPid = path.join(tmpDir, "bg.pid");
    const promise = runStep(
      shStep("echo $$ > \"$1\"; sleep 30 & echo $! > \"$2\"; wait", {}, shellPid, bgPid),
      {
        baseDir: tmpDir,
        output: { mode: "stream", output: { stdout: () => undefined, stderr: () => undefined } },
        signal: controller.signal,
      }
    );
    const ready = () =>
      [shellPid, bgPid].every(
        (f) => fs.existsSync(f) && fs.readFileSync(f, "utf-8").trim().length > 0
      );
    expect(await waitFor(ready)).toBe(true);
    const pids = [shellPid, bgPid].map((f) => Number(fs.readFileSync(f, "utf-8").trim()));
    controller.abort();
    expect(await promise).toEqual({ status: "interrupted" });
    for (const pid of pids) {
      expect(await waitFor(() => !isAlive(pid), 2000)).toBe(true);
    }
  }, 10000);

  it("stepText equals formatCommand(program, args)", () => {
    const step: BuildStep = { label: "x", program: "./configure", args: ["--prefix=/a b", "it's"] };
    expect(stepText(step)).toBe(formatCommand(step.program, step.args));
  });
});
