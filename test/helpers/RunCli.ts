/*
 * Helpers for tests that run the command line in-process.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - `runCli(argv, configDir, context?)` takes the words after the program name and an optional
 *   third argument `{ interactive?: boolean }`, which overrides whether prompts may be shown; when
 *   it is left out the handlers see whether standard input and output are terminals.
 * - `runTheSeed` reads the status from `process.exitCode` (the only place the tool sets it) and
 *   restores the previous value afterwards. `process.exit` is replaced so that a handler that
 *   still calls it fails the case instead of ending the test run.
 * - `stdout` and `stderr` hold every `console.log` and `console.error` call formatted like the
 *   console does, each followed by a newline.
 * - `interactive` defaults to true when `answers` is given and to false otherwise.
 * - Prompts are recorded as the question lists passed to `inquirer.prompt`. A prompt for which no
 *   answer is left rejects, and the case then fails after the command has ended.
 * - A scratch home that the helper creates itself is removed when the command ends; pass `home`
 *   to keep one.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as util from "util";
import inquirer from "inquirer";
import { runCli } from "../../src/scripts/Cli";

/** What `runTheSeed` can be told. */
export interface RunOptions {
  /** HOME for the run; a fresh scratch directory (removed afterwards) when omitted */
  home?: string;
  /** The configuration directory; `<home>/the-seed` when omitted */
  configDir?: string;
  /** The working directory for the run; the current one when omitted */
  cwd?: string;
  /** Whether prompts may be shown; true when `answers` is given, false otherwise */
  interactive?: boolean;
  /** The answers to the prompts, in the order they are asked */
  answers?: unknown[];
}

/** What a run produced. */
export interface RunResult {
  /** The exit status: `process.exitCode`, or 0 when it was not set */
  status: number;
  stdout: string;
  stderr: string;
  /** The question lists of the prompts that were shown, in order */
  prompts: unknown[];
}

type RunCliWithContext = (argv: string[], configDir: string, context?: { interactive?: boolean }) => Promise<void>;

/**
 * Runs `the-seed <args>` in-process with a scratch HOME and configuration directory and returns the
 * status and what was printed. Nothing is printed and the process is never ended.
 */
export async function runTheSeed(args: string[], options: RunOptions = {}): Promise<RunResult> {
  const ownsHome = options.home === undefined;
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "the-seed-run-"));
  const configDir = options.configDir ?? path.join(home, "the-seed");
  const interactive = options.interactive ?? options.answers !== undefined;
  const answers = [...(options.answers ?? [])];
  const out: string[] = [];
  const err: string[] = [];
  const prompts: unknown[] = [];
  const unexpected: unknown[] = [];

  const savedHome = process.env.HOME;
  const savedExitCode = process.exitCode;
  const savedCwd = process.cwd();
  const logSpy = jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    out.push(util.format(...parts) + "\n");
  });
  const errorSpy = jest.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    err.push(util.format(...parts) + "\n");
  });
  const exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error("process.exit(" + String(code ?? 0) + ") was called; a handler must return or throw instead");
  }) as never);
  const promptSpy = jest.spyOn(inquirer, "prompt").mockImplementation(((questions: unknown) => {
    prompts.push(questions);
    if (answers.length === 0) {
      unexpected.push(questions);
      return Promise.reject(new Error("Unexpected prompt: " + util.inspect(questions, { depth: 3 })));
    }
    return Promise.resolve(answers.shift());
  }) as never);

  process.env.HOME = home;
  process.exitCode = undefined;
  if (options.cwd !== undefined) {
    process.chdir(options.cwd);
  }
  let status = 0;
  try {
    await (runCli as unknown as RunCliWithContext)(args, configDir, { interactive });
    status = typeof process.exitCode === "number" ? process.exitCode : 0;
  } finally {
    process.chdir(savedCwd);
    promptSpy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = savedExitCode;
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (ownsHome) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  if (unexpected.length > 0) {
    throw new Error("the command asked for a prompt the case did not expect: " + util.inspect(unexpected[0], { depth: 3 }));
  }
  return { status, stdout: out.join(""), stderr: err.join(""), prompts };
}

/** One file of a snapshotted tree. */
export interface TreeEntry {
  /** Path relative to the snapshotted directory, with `/` separators. */
  path: string;
  /** `directory` or `file`. */
  kind: "directory" | "file";
  /** Size in bytes (0 for a directory). */
  size: number;
  /** SHA-256 of the contents as hex (empty for a directory). */
  sha256: string;
}

/**
 * Lists every file and directory under `dir` in sorted order with its size and SHA-256, so a test
 * can show that a command created, changed or deleted nothing by comparing two snapshots.
 */
export function snapshotTree(dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(dir, full).split(path.sep).join("/");
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        entries.push({ path: relative, kind: "directory", size: 0, sha256: "" });
        walk(full);
      } else {
        const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(full)) : fs.readFileSync(full);
        entries.push({
          path: relative,
          kind: "file",
          size: bytes.length,
          sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  };
  walk(dir);
  return entries;
}
