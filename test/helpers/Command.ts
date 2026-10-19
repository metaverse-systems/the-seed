import { runCli } from "../../src/scripts/Cli";

export interface CommandRun {
  /** The first status passed to process.exit, or 0 when the command never called it. */
  status: number;
  /** Everything written with console.log, one line per call. */
  out: string;
  /** Everything written with console.error, one line per call. */
  err: string;
}

class ExitSignal extends Error {
  constructor(public readonly code: number) {
    super("process.exit(" + code + ")");
  }
}

/**
 * Runs `the-seed signing verify <args>` through runCli with the given scratch configuration
 * directory and a scratch HOME (restored afterwards). process.exit is replaced by a function that
 * records the first status and throws, so the command stops where it would have ended; the console
 * is captured. Nothing is printed and the process is never ended.
 */
export async function runVerify(args: string[], configDir: string, home: string): Promise<CommandRun> {
  return runSigningCommand("verify", args, configDir, home);
}

/** Runs `the-seed signing sign <args>` the same way as `runVerify`. */
export async function runSign(args: string[], configDir: string, home: string): Promise<CommandRun> {
  return runSigningCommand("sign", args, configDir, home);
}

async function runSigningCommand(command: string, args: string[], configDir: string, home: string): Promise<CommandRun> {
  const savedHome = process.env.HOME;
  const codes: number[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const exitSpy = jest.spyOn(process, "exit").mockImplementation(((code?: number) => {
    codes.push(code ?? 0);
    throw new ExitSignal(code ?? 0);
  }) as never);
  const logSpy = jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  });
  const errorSpy = jest.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  });
  process.env.HOME = home;
  try {
    await runCli(["node", "the-seed", "signing", command, ...args], configDir, "the-seed");
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      throw error;
    }
  } finally {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
  }
  return { status: codes.length > 0 ? codes[0] : 0, out: out.join("\n"), err: err.join("\n") };
}
