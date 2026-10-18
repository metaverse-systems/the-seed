import path from "path";
import { runCommand, formatCommand, formatFailureOutput } from "./ProcessRunner";
import { BuildStep } from "./types";

/** What happened when one build step was run. */
export type StepOutcome =
  | { status: "completed" }
  /** A step marked ignoreExitCode exited non-zero */
  | { status: "ignored"; exitCode: number | null }
  /** `output` is the captured text in capture mode and "" in stream mode */
  | { status: "failed"; exitCode: number | null; signal: NodeJS.Signals | null; output: string }
  /** The program could not be started */
  | { status: "notFound"; message: string }
  /** The step was stopped by the abort signal */
  | { status: "interrupted" };

export type StepOutputMode =
  | { mode: "capture" }
  | { mode: "stream"; output: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void } };

export interface RunStepOptions {
  /** The step's relative working directory is resolved against this */
  baseDir: string;
  /** The environment the step's own values are laid over; process.env when omitted */
  baseEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  output: StepOutputMode;
}

/** The step's command as one line for messages. */
export function stepText(step: BuildStep): string {
  return formatCommand(step.program, step.args);
}

/** Runs one build step and reports how it ended. */
export async function runStep(step: BuildStep, options: RunStepOptions): Promise<StepOutcome> {
  if (options.signal?.aborted) {
    return { status: "interrupted" };
  }

  const cwd = path.resolve(options.baseDir, step.cwd ?? ".");
  const env = { ...(options.baseEnv ?? process.env), ...step.env };

  let run;
  try {
    run = await runCommand(step.program, step.args, {
      cwd,
      env,
      signal: options.signal,
      output: options.output.mode === "stream" ? options.output.output : undefined,
    });
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    const message = err.code === "ENOENT" ? `${step.program}: not found` : `${step.program}: ${err.message}`;
    return { status: "notFound", message };
  }

  if (run.killed) {
    return { status: "interrupted" };
  }
  if (run.exitCode === 0) {
    return { status: "completed" };
  }
  if (step.ignoreExitCode) {
    return { status: "ignored", exitCode: run.exitCode };
  }
  return {
    status: "failed",
    exitCode: run.exitCode,
    signal: run.signal,
    output: options.output.mode === "capture" ? formatFailureOutput(stepText(step), run.stdout, run.stderr) : "",
  };
}
