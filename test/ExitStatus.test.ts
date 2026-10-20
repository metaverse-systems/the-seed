/**
 * Tests for the exit-status table and the error classes of the command-line layer (the group
 * `scheme`), and for the statuses and output of the commands run end to end (the group
 * `end to end`, through `runTheSeed` with scratch homes and working directories).
 *
 * Choices where the contracts leave a detail open, for the group `end to end`:
 * - A failure prints `Error: <message>` followed by the hint on its own line, both on standard
 *   error; the message of a missing native component is printed as `Error: <message>`.
 * - Statuses are those of the table of statuses (condition to status, per command). The table-driven
 *   case at the end checks that every status the cases of a command produced is one its rows list,
 *   and that every case ran (`observed` is filled by `exec`, which every case uses). The case of an
 *   unexpected error is left out of that record, because every command can produce it.
 * - A case that needs a certificate to be expired replaces `Signing.getCertInfo` by a wrapper that
 *   reports the stored certificate as expired.
 * - A failing step of `dependencies install` is made by replacing `installLibEcs` in the module
 *   `Dependencies`; an unexpected error is made by replacing `checkLibEcs` with a function that
 *   throws a `TypeError`, run as `dependencies check`.
 * - A scratch directory is a project of the resource-pak kind when it has a `package.json`.
 *
 * Interfaces this file expects from `src/cli/ExitStatus.ts`:
 *
 * - `EXIT_STATUSES: Array<{ status: string; meaning: string }>`.
 * - `new CliError(status: number, message: string, options?: { hint?: string; usage?: string })`
 *   with the readable fields `status`, `message`, `hint` and `usage`.
 * - `new UsageError(message: string, details: { argument: string; command: string;
 *   subcommand?: string; usage: string })`: status 3, the fields `argument`, `command`,
 *   `subcommand`, `usage` (the complete usage line, as given) and `hint` set to the help hint
 *   `helpHint(command, subcommand)`.
 * - `new MissingError(message: string, options?: { hint?: string })`: status 2.
 * - `new FailedError(message: string, options?: { hint?: string; reported?: boolean })`: status
 *   1, with `reported` false when not given.
 * - Each class sets `name` to its own name and works with `instanceof` after compilation.
 */
import { EXIT_STATUSES, CliError, UsageError, MissingError, FailedError } from "../src/cli/ExitStatus";
import { helpHint, addScopeHint, createCertHint } from "../src/cli/Hints";
import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { runTheSeed, RunOptions, RunResult } from "./helpers/RunCli";
import { nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";
import { COMMANDS } from "../src/cli/Commands";

// Only the functions the cases replace are wrapped; the others are the real ones.
jest.mock("../src/Dependencies", () => {
  const actual = jest.requireActual("../src/Dependencies");
  return { ...actual, checkLibEcs: jest.fn(actual.checkLibEcs), checkLibTheSeed: jest.fn(actual.checkLibTheSeed), installLibEcs: jest.fn(actual.installLibEcs) };
});
import * as Dependencies from "../src/Dependencies";

describe("scheme", () => {
  describe("EXIT_STATUSES", () => {
    it("has the rows 0, 1, 2, 3, 4 and 128+N in order", () => {
      expect(EXIT_STATUSES.map((row) => row.status)).toEqual(["0", "1", "2", "3", "4", "128+N"]);
    });

    it("gives each row the meaning of the scheme", () => {
      const meanings = EXIT_STATUSES.map((row) => row.meaning);
      expect(meanings[0]).toMatch(/did what was asked/i);
      expect(meanings[0]).toMatch(/help/i);
      expect(meanings[0]).toMatch(/valid/i);
      expect(meanings[1]).toMatch(/ran/i);
      expect(meanings[1]).toMatch(/failure/i);
      expect(meanings[1]).toMatch(/declined to overwrite/i);
      expect(meanings[1]).toMatch(/unexpected internal error/i);
      expect(meanings[2]).toMatch(/missing or unusable/i);
      expect(meanings[2]).toMatch(/scopes/i);
      expect(meanings[2]).toMatch(/certificate/i);
      expect(meanings[3]).toMatch(/usage error/i);
      expect(meanings[3]).toMatch(/cannot interpret/i);
      expect(meanings[4]).toMatch(/verification only/i);
      expect(meanings[4]).toMatch(/not trusted/i);
      expect(meanings[5]).toMatch(/signal N/);
      expect(meanings[5]).toMatch(/130/);
    });

    it("keeps every meaning on one line", () => {
      for (const row of EXIT_STATUSES) {
        expect(row.meaning).not.toContain("\n");
        expect(row.meaning.trim()).toBe(row.meaning);
        expect(row.meaning.length).toBeGreaterThan(10);
      }
    });
  });

  describe("UsageError", () => {
    const details = {
      argument: "--zz",
      command: "signing",
      subcommand: "sign",
      usage: "Usage: the-seed signing sign <path> [--scope <scope>]",
    };
    const error = new UsageError("Unknown option \"--zz\" for \"the-seed signing sign\".", details);

    it("has status 3 and carries the argument, command, subcommand, usage line and help hint", () => {
      expect(error.status).toBe(3);
      expect(error.argument).toBe("--zz");
      expect(error.command).toBe("signing");
      expect(error.subcommand).toBe("sign");
      expect(error.usage).toBe(details.usage);
      expect(error.hint).toBe(helpHint("signing", "sign"));
      expect(error.hint).toBe("Run \"the-seed help signing sign\" for details.");
    });

    it("has a help hint for the command alone and for no command", () => {
      const commandOnly = new UsageError("m", { argument: "x", command: "build", usage: "Usage: the-seed build" });
      expect(commandOnly.subcommand).toBeUndefined();
      expect(commandOnly.hint).toBe("Run \"the-seed help build\" for details.");
    });

    it("is a CliError and an Error that instanceof recognises, with its own name", () => {
      expect(error).toBeInstanceOf(UsageError);
      expect(error).toBeInstanceOf(CliError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("UsageError");
    });

    it("has a one-line message without an Error: prefix", () => {
      expect(error.message).toBe("Unknown option \"--zz\" for \"the-seed signing sign\".");
      expect(error.message).not.toContain("\n");
      expect(error.message.startsWith("Error:")).toBe(false);
    });
  });

  describe("MissingError", () => {
    it("has status 2 and carries a hint", () => {
      const error = new MissingError("No scopes are configured.", { hint: "Add one with \"the-seed scopes add\"." });
      expect(error.status).toBe(2);
      expect(error.message).toBe("No scopes are configured.");
      expect(error.hint).toBe("Add one with \"the-seed scopes add\".");
      expect(error).toBeInstanceOf(MissingError);
      expect(error).toBeInstanceOf(CliError);
      expect(error.name).toBe("MissingError");
    });

    it("has no hint when none is given", () => {
      expect(new MissingError("gone").hint).toBeUndefined();
    });
  });

  describe("FailedError", () => {
    it("has status 1 and is not reported unless said so", () => {
      const error = new FailedError("Build failed.");
      expect(error.status).toBe(1);
      expect(error.reported).toBe(false);
      expect(error).toBeInstanceOf(FailedError);
      expect(error).toBeInstanceOf(CliError);
      expect(error.name).toBe("FailedError");
    });

    it("keeps reported and the hint", () => {
      const error = new FailedError("Build failed.", { reported: true, hint: "Try again." });
      expect(error.reported).toBe(true);
      expect(error.hint).toBe("Try again.");
    });
  });

  describe("CliError", () => {
    it("keeps the status it is given", () => {
      for (const status of [1, 2, 3, 4, 130]) {
        const error = new CliError(status, "Something happened.");
        expect(error.status).toBe(status);
        expect(error.message).toBe("Something happened.");
        expect(error.hint).toBeUndefined();
        expect(error.usage).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("CliError");
      }
    });

    it("keeps a hint and a usage line", () => {
      const error = new CliError(3, "m", { hint: "h.", usage: "Usage: the-seed" });
      expect(error.hint).toBe("h.");
      expect(error.usage).toBe("Usage: the-seed");
    });

    it("is not a UsageError, MissingError or FailedError", () => {
      const error = new CliError(2, "m");
      expect(error).not.toBeInstanceOf(UsageError);
      expect(error).not.toBeInstanceOf(MissingError);
      expect(error).not.toBeInstanceOf(FailedError);
    });
  });
});

// ── Commands run end to end ─────────────────────────────────

const created: string[] = [];

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A home with a configuration of the given scopes (name to author name) and a working directory. */
interface Env {
  home: string;
  configDir: string;
  cwd: string;
}

function makeEnv(scopes: string[] = []): Env {
  const home = scratch("exit-home-");
  const configDir = path.join(home, "the-seed");
  fs.mkdirSync(configDir, { recursive: true });
  const config: Record<string, { author: { name: string; email: string; url: string } }> = {};
  for (const scope of scopes) {
    config[scope] = { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } };
  }
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(home, "prefix"), scopes: config }, null, 2));
  return { home, configDir, cwd: scratch("exit-cwd-") };
}

const observed = new Map<string, Set<number>>();

/** Checks that nothing the run printed is a stack frame, an object dump, a buffer dump or a repeated error line. */
function expectCleanOutput(run: RunResult, allowStack = false): void {
  for (const text of [run.stdout, run.stderr]) {
    if (!allowStack) {
      expect(text).not.toContain("    at ");
    }
    expect(text).not.toContain("[object Object]");
    expect(text).not.toContain("<Buffer");
  }
  const errorLines = run.stderr.split("\n").filter((line) => line.startsWith("Error:"));
  expect(new Set(errorLines).size).toBe(errorLines.length);
}

/** Runs the command line in the environment, checks the output for dumps, and records the status for the command. */
async function exec(args: string[], env: Env, options: Partial<RunOptions> = {}): Promise<RunResult> {
  const run = await runTheSeed(args, { home: env.home, configDir: env.configDir, cwd: env.cwd, ...options });
  expectCleanOutput(run);
  const command = args[0];
  if (!observed.has(command)) observed.set(command, new Set());
  observed.get(command)?.add(run.status);
  return run;
}

/** The lines of standard error that start with "Error:". */
function errorLines(run: RunResult): string[] {
  return run.stderr.split("\n").filter((line) => line.startsWith("Error:"));
}

function sampleMacho(): string {
  const file = path.join(scratch("exit-file-"), "tiny-macho-arm64");
  fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
  return file;
}

async function withCertificate(env: Env, scope: string): Promise<Signing> {
  const signing = new Signing(env.configDir);
  await signing.createCert({ validityDays: 365, scope });
  return signing;
}

afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("end to end", () => {
  describe("usage", () => {
    it("an unknown command is 3, with the message on standard error and nothing on standard output", async () => {
      const run = await exec(["bogus"], makeEnv());
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      expect(errorLines(run)).toHaveLength(1);
      expect(run.stderr).toContain("bogus");
    });

    it.each(["config", "scopes", "dependencies", "resource-pak", "installer", "signing"])("%s bogus is 3", async (command) => {
      const run = await exec([command, "bogus"], makeEnv());
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("bogus");
    });

    it.each(COMMANDS.filter((command) => command.name !== "help").map((command) => [command.name]))("%s with an unknown option is 3", async (name) => {
      const run = await exec([name, "--zz"], makeEnv());
      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
    });

    it.each(["scopes", "template", "dependencies", "package", "resource-pak", "signing", "installer"])("%s alone prints its help and is 0", async (name) => {
      const run = await exec([name], makeEnv());
      expect(run.status).toBe(0);
      expect(run.stdout).not.toBe("");
      expect(run.stderr).toBe("");
    });

    it("build usage errors are 3", async () => {
      const run = await exec(["build", "native", "--jobs", "0"], makeEnv());
      expect(run.status).toBe(3);
    });

    it("package without a project directory is 3", async () => {
      const env = makeEnv();
      const run = await exec(["package", path.join(env.cwd, "out")], env);
      expect(run.status).toBe(3);
    });

    it("dependencies check with an unknown target is 3", async () => {
      const run = await exec(["dependencies", "check", "macos"], makeEnv());
      expect(run.status).toBe(3);
    });
  });

  describe("scopes and certificates", () => {
    const noScopeCommands: Array<[string, string[]]> = [
      ["create-cert", ["create-cert"]],
      ["import-cert", ["import-cert", "--cert", "c.pem", "--key", "k.pem"]],
      ["sign", ["sign", "somefile"]],
      ["cert-info", ["cert-info"]],
      ["export-cert", ["export-cert", "--output", "out.pem"]],
    ];

    it.each(noScopeCommands)("%s with no scopes is 2, naming the command that adds one", async (_name, words) => {
      const run = await exec(["signing", ...words], makeEnv());
      expect(run.status).toBe(2);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("\"the-seed scopes add\"");
      expect(run.stderr).toContain(addScopeHint());
      expect(errorLines(run)).toHaveLength(1);
    });

    it("sign with no certificate is 2, with the command that creates one for the scope", async () => {
      const env = makeEnv(["@a"]);
      const run = await exec(["signing", "sign", sampleMacho(), "--scope", "@a"], env);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain(createCertHint("@a"));
      expect(errorLines(run)).toHaveLength(1);
    });

    it("sign with an expired certificate and no --force is 2", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const original = Signing.prototype.getCertInfo;
      jest.spyOn(Signing.prototype, "getCertInfo").mockImplementation(function (this: Signing, scope: string) {
        const info = original.call(this, scope);
        return info === null ? null : { ...info, isExpired: true };
      });
      const file = sampleMacho();
      const run = await exec(["signing", "sign", file, "--scope", "@a"], env);
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("expired");
      expect(errorLines(run)).toHaveLength(1);
    });

    it("sign of a directory with no binary files is 1", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const dir = scratch("exit-texts-");
      fs.writeFileSync(path.join(dir, "a.txt"), "text\n");
      const run = await exec(["signing", "sign", dir, "--scope", "@a"], env);
      expect(run.status).toBe(1);
      expect(errorLines(run)).toHaveLength(1);
    });

    it("sign of a path that does not exist is 2", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const run = await exec(["signing", "sign", path.join(env.cwd, "absent.bin"), "--scope", "@a"], env);
      expect(run.status).toBe(2);
    });

    it("import-cert with a key that does not match the certificate is 2", async () => {
      const env = makeEnv(["@a"]);
      const other = makeEnv(["@x", "@y"]);
      await withCertificate(other, "@x");
      await withCertificate(other, "@y");
      const cert = path.join(other.configDir, "signing", "@x", "cert.pem");
      const key = path.join(other.configDir, "signing", "@y", "key.pem");
      const run = await exec(["signing", "import-cert", "--cert", cert, "--key", key, "--scope", "@a"], env);
      expect(run.status).toBe(2);
      expect(errorLines(run)).toHaveLength(1);
    });

    it("import-cert with files that do not exist is 2", async () => {
      const env = makeEnv(["@a"]);
      const run = await exec(["signing", "import-cert", "--cert", path.join(env.cwd, "no.pem"), "--key", path.join(env.cwd, "no-key.pem"), "--scope", "@a"], env);
      expect(run.status).toBe(2);
      expect(errorLines(run)).toHaveLength(1);
    });

    it("import-cert without --cert is 3", async () => {
      const env = makeEnv(["@a"]);
      const run = await exec(["signing", "import-cert", "--key", path.join(env.cwd, "k.pem")], env);
      expect(run.status).toBe(3);
    });

    it("export-cert without --output is 3", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const run = await exec(["signing", "export-cert", "--scope", "@a"], env);
      expect(run.status).toBe(3);
    });

    it("create-cert over an existing certificate, declined at the confirmation, is 1", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const before = fs.readFileSync(path.join(env.configDir, "signing", "@a", "cert.pem"), "utf-8");
      const run = await exec(["signing", "create-cert", "--scope", "@a"], env, { interactive: true, answers: [{ overwrite: false }] });
      expect(run.status).toBe(1);
      expect(run.prompts).toHaveLength(1);
      expect(fs.readFileSync(path.join(env.configDir, "signing", "@a", "cert.pem"), "utf-8")).toBe(before);
    });

    it("create-cert over an existing certificate, not interactive and without --force, is 3", async () => {
      const env = makeEnv(["@a"]);
      await withCertificate(env, "@a");
      const run = await exec(["signing", "create-cert", "--scope", "@a"], env, { interactive: false });
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("--force");
    });

    it("an unknown --scope is 2 for each of the five commands", async () => {
      const env = makeEnv(["@a"]);
      for (const words of [["create-cert"], ["sign", "f"], ["cert-info"], ["export-cert", "--output", "o.pem"], ["import-cert", "--cert", "c", "--key", "k"]]) {
        const run = await exec(["signing", ...words, "--scope", "@nope"], env);
        expect(run.status).toBe(2);
        expect(run.stderr).toContain("@nope");
      }
    });

    it("two scopes, not interactive and no --scope, is 3 naming --scope, with no prompt", async () => {
      const env = makeEnv(["@a", "@b"]);
      const run = await exec(["signing", "cert-info"], env, { interactive: false });
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("--scope");
      expect(run.prompts).toEqual([]);
    });
  });

  describe("verify outcomes (guard: the statuses of verification are unchanged)", () => {
    it("0 for a valid file, 4 for one signed by another scope's key, 1 for an altered file, 2 for a missing path, 3 for a signature file", async () => {
      const env = makeEnv(["@a"]);
      const signing = await withCertificate(env, "@a");
      const file = sampleMacho();
      await signing.signFile(file, { scope: "@a" });
      expect((await exec(["signing", "verify", file], env)).status).toBe(0);

      const stranger = makeEnv(["@z"]);
      await withCertificate(stranger, "@z");
      expect((await exec(["signing", "verify", file], stranger)).status).toBe(4);

      const detached = path.join(scratch("exit-detached-"), "program");
      fs.copyFileSync("/bin/true", detached);
      await signing.signFile(detached, { scope: "@a" });
      expect((await exec(["signing", "verify", detached], env)).status).toBe(0);
      fs.appendFileSync(detached, Buffer.from([1, 2, 3]));
      expect((await exec(["signing", "verify", detached], env)).status).toBe(1);

      expect((await exec(["signing", "verify", path.join(env.cwd, "absent")], env)).status).toBe(2);
      expect((await exec(["signing", "verify", detached + ".sig"], env)).status).toBe(3);
    });
  });

  describe("configuration and project", () => {
    function brokenEnv(): Env {
      const env = makeEnv();
      fs.writeFileSync(path.join(env.configDir, "config.json"), JSON.stringify({ prefix: 3, scopes: {} }));
      return env;
    }

    it.each([["config", "list"], ["scopes", "list"], ["build", "native"]])("an invalid configuration file is 2 for %s %s, with one line on standard error", async (...words) => {
      const run = await exec(words, brokenEnv());
      expect(run.status).toBe(2);
      expect(run.stdout).not.toContain("prefix");
      expect(errorLines(run)).toHaveLength(1);
    });

    it("resource-pak add outside a pak project is 2 with one Error line and no stack", async () => {
      const run = await exec(["resource-pak", "add", "x", "f"], makeEnv());
      expect(run.status).toBe(2);
      expect(errorLines(run)).toHaveLength(1);
      expect(run.stderr).toContain("package.json");
    });

    it("resource-pak build outside a pak project is 2 with one Error line and no stack", async () => {
      const run = await exec(["resource-pak", "build"], makeEnv());
      expect(run.status).toBe(2);
      expect(errorLines(run)).toHaveLength(1);
    });

    it("resource-pak add with a file that does not exist is 2 and leaves the project description unchanged", async () => {
      const env = makeEnv();
      const description = JSON.stringify({ name: "@a/pak", version: "1.0.0" });
      fs.writeFileSync(path.join(env.cwd, "package.json"), description);
      const run = await exec(["resource-pak", "add", "x", "missing.dat"], env);
      expect(run.status).toBe(2);
      expect(errorLines(run)).toHaveLength(1);
      expect(fs.readFileSync(path.join(env.cwd, "package.json"), "utf-8")).toBe(description);
    });
  });

  describe("the native component is missing", () => {
    type RunModule = typeof import("./helpers/RunCli");
    type ComponentModule = typeof import("../src/NativeComponent");
    let isolated: { run: RunModule["runTheSeed"]; component: ComponentModule };

    beforeEach(() => {
      isolated = withoutNativeComponent(() => ({
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
        run: (require("./helpers/RunCli") as RunModule).runTheSeed,
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- the message comes from the same registry
        component: require("../src/NativeComponent") as ComponentModule,
      }));
    });

    afterEach(() => {
      jest.dontMock(nativeComponentPath);
    });

    function record(args: string[], run: RunResult): void {
      expectCleanOutput(run);
      if (!observed.has(args[0])) observed.set(args[0], new Set());
      observed.get(args[0])?.add(run.status);
    }

    it("build windows is 2 with the message alone on standard error", async () => {
      const env = makeEnv();
      fs.writeFileSync(path.join(env.cwd, "package.json"), JSON.stringify({ name: "@a/p", version: "1.0.0" }));
      const args = ["build", "windows"];
      const run = await isolated.run(args, { home: env.home, configDir: env.configDir, cwd: env.cwd });
      record(args, run);
      expect(run.status).toBe(2);
      expect(run.stderr).toBe("Error: " + isolated.component.nativeComponentMessage() + "\n");
    });

    it("package is 2 with the message once on standard error", async () => {
      const env = makeEnv();
      const project = path.join(env.cwd, "project");
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "@a/p", version: "1.0.0" }));
      const args = ["package", path.join(env.cwd, "out"), project];
      const run = await isolated.run(args, { home: env.home, configDir: env.configDir, cwd: env.cwd });
      record(args, run);
      expect(run.status).toBe(2);
      expect(run.stderr.split(isolated.component.nativeComponentMessage()).length - 1).toBe(1);
      expect(errorLines(run)).toHaveLength(1);
    });
  });

  describe("dependencies", () => {
    it("install with a failing step is 1", async () => {
      jest.mocked(Dependencies.checkLibEcs).mockReturnValue(false);
      jest.mocked(Dependencies.checkLibTheSeed).mockReturnValue(true);
      jest.mocked(Dependencies.installLibEcs).mockResolvedValue(false);
      const run = await exec(["dependencies", "install"], makeEnv());
      expect(run.status).toBe(1);
      expect(errorLines(run)).toHaveLength(1);
      expect(run.stdout).not.toContain("installed successfully");
    });

    it("check reporting a missing library is 0", async () => {
      jest.mocked(Dependencies.checkLibEcs).mockReturnValue(false);
      jest.mocked(Dependencies.checkLibTheSeed).mockReturnValue(false);
      const run = await exec(["dependencies", "check"], makeEnv());
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("not installed");
    });
  });

  describe("an unexpected error", () => {
    it("is one line with status 1", async () => {
      jest.mocked(Dependencies.checkLibEcs).mockImplementation(() => {
        throw new TypeError("boom");
      });
      const run = await runTheSeed(["dependencies", "check"], { home: makeEnv().home });
      expectCleanOutput(run);
      expect(run.status).toBe(1);
      expect(run.stderr).toBe("Error: Unexpected error in \"the-seed dependencies check\": boom\n");
    });

    it("is followed by the stack with THE_SEED_DEBUG=1", async () => {
      jest.mocked(Dependencies.checkLibEcs).mockImplementation(() => {
        throw new TypeError("boom");
      });
      const saved = process.env.THE_SEED_DEBUG;
      process.env.THE_SEED_DEBUG = "1";
      try {
        const run = await runTheSeed(["dependencies", "check"], { home: makeEnv().home });
        expectCleanOutput(run, true);
        expect(run.status).toBe(1);
        const lines = run.stderr.split("\n");
        expect(lines[0]).toBe("Error: Unexpected error in \"the-seed dependencies check\": boom");
        expect(run.stderr).toContain("TypeError: boom");
        expect(run.stderr).toContain("    at ");
      } finally {
        if (saved === undefined) delete process.env.THE_SEED_DEBUG;
        else process.env.THE_SEED_DEBUG = saved;
      }
    });
  });

  describe("statuses per command", () => {
    // The statuses of contracts/exit-status.md's rows, by command, for the conditions these cases can produce.
    const allowed: Record<string, number[]> = {
      config: [0, 2, 3],
      scopes: [0, 2, 3],
      template: [0, 3],
      build: [0, 1, 2, 3],
      dependencies: [0, 1, 3],
      package: [0, 1, 2, 3],
      "resource-pak": [0, 2, 3],
      signing: [0, 1, 2, 3, 4],
      installer: [0, 1, 2, 3],
    };

    it.each(Object.keys(allowed))("%s produced only statuses its rows list", (command) => {
      const statuses = observed.get(command);
      expect(statuses).toBeDefined();
      for (const status of statuses ?? []) {
        expect(allowed[command]).toContain(status);
      }
    });

    it("signing produced every status of verification and of its failures", () => {
      expect([...(observed.get("signing") ?? [])].sort()).toEqual([0, 1, 2, 3, 4]);
    });
  });
});
