/**
 * Tests for the hint sentences (the group `hint texts`), for the command lines in the source (the
 * groups `source scan` and `self-test`, which use `test/helpers/HintScan.ts`) and for the hints as
 * the commands print them (the group `following a hint`).
 *
 * Choices where the contracts leave a detail open:
 * - The scan reads `src/**` `*.ts` and `native/*.js`; the rules it applies (which text counts as a
 *   command line, how optional parts and placeholders are read, usage synopses) are in the header
 *   of `test/helpers/HintScan.ts`.
 * - In `following a hint`, the printed hint is searched for the first double-quoted span that
 *   starts with `the-seed `, and exactly those words are run through `runTheSeed` in the same
 *   scratch home. The hint sentence is expected on standard error (where errors and hints go).
 *   `signing sign` is given a copy of a small Mac binary from the fixtures.
 * - An expired certificate is made by replacing `Signing.getCertInfo` with a wrapper that reports
 *   the stored certificate as expired; the wrapper is removed before the hint is followed.
 * - A scope-name prompt answer for `scopes add` is `{ scopeName, authorName, authorEmail, authorURL }`,
 *   and for `scopes edit` the answers are the scope to edit followed by the new author fields.
 * - The usage errors whose help hint is followed are: an unknown command, an unknown subcommand,
 *   an unknown option and a missing option value, for several commands.
 *
 * Interfaces this file expects: `src/cli/Hints.ts` exports the functions `addScopeHint()`,
 * `editScopeHint(scope)`, `createCertHint(scope)`, `replaceCertHint(scope)`,
 * `chooseScopeHint(scopes: string[])`, `forceHint(scope)`, `listScopesHint()`,
 * `helpHint(command?, subcommand?)`, `buildWindowsHint()`, `fullBuildHint()` and
 * `resignHint(path?)`, each returning one sentence.
 */
import {
  addScopeHint,
  editScopeHint,
  createCertHint,
  replaceCertHint,
  chooseScopeHint,
  forceHint,
  listScopesHint,
  helpHint,
  buildWindowsHint,
  fullBuildHint,
  resignHint,
} from "../src/cli/Hints";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Signing from "../src/Signing";
import { hintSourceFiles, scanHintFiles, scanHintText, checkCommandLine } from "./helpers/HintScan";
import { runTheSeed, RunResult } from "./helpers/RunCli";

describe("hint texts", () => {
  it("addScopeHint", () => {
    expect(addScopeHint()).toBe("Add one with \"the-seed scopes add\".");
  });

  it("editScopeHint", () => {
    expect(editScopeHint("@a")).toBe("Set the author's name with \"the-seed scopes edit\" (scope @a).");
  });

  it("createCertHint", () => {
    expect(createCertHint("@a")).toBe("Create one with \"the-seed signing create-cert --scope @a\".");
  });

  it("replaceCertHint", () => {
    expect(replaceCertHint("@a")).toBe("Create a new one with \"the-seed signing create-cert --scope @a --force\".");
  });

  it("chooseScopeHint", () => {
    expect(chooseScopeHint(["@a", "@b"])).toBe(
      "Several scopes are configured; choose one with --scope <scope>. Configured scopes: @a, @b."
    );
  });

  it("forceHint", () => {
    expect(forceHint("@a")).toBe("A certificate already exists for scope @a; give --force to replace it.");
  });

  it("listScopesHint", () => {
    expect(listScopesHint()).toBe("Scopes are listed with \"the-seed scopes list\".");
  });

  it("helpHint without arguments, with a command and with a command and subcommand", () => {
    expect(helpHint()).toBe("Run \"the-seed help\" for details.");
    expect(helpHint("signing")).toBe("Run \"the-seed help signing\" for details.");
    expect(helpHint("signing", "sign")).toBe("Run \"the-seed help signing sign\" for details.");
  });

  it("buildWindowsHint", () => {
    expect(buildWindowsHint()).toBe("Cross-compile the project first with \"the-seed build windows\".");
  });

  it("fullBuildHint", () => {
    expect(fullBuildHint()).toBe("Run a full build (\"the-seed build native\" or \"the-seed build windows\").");
  });

  it("resignHint with and without a path", () => {
    expect(resignHint()).toBe("Sign the file again with \"the-seed signing sign <path>\".");
    expect(resignHint("./app.exe")).toBe("Sign the file again with \"the-seed signing sign ./app.exe\".");
  });

  it("every hint is one line", () => {
    const hints = [
      addScopeHint(),
      editScopeHint("@a"),
      createCertHint("@a"),
      replaceCertHint("@a"),
      chooseScopeHint(["@a", "@b"]),
      forceHint("@a"),
      listScopesHint(),
      helpHint(),
      buildWindowsHint(),
      fullBuildHint(),
      resignHint(),
    ];
    for (const hint of hints) {
      expect(hint).not.toContain("\n");
      expect(hint.endsWith(".")).toBe(true);
    }
  });
});

const packageRoot = path.join(__dirname, "..");

function describeFindings(findings: Array<{ file: string; line: number; reason: string }>): string[] {
  return findings.map((finding) => `${finding.file}:${finding.line}: ${finding.reason}`);
}

describe("source scan", () => {
  const files = hintSourceFiles(packageRoot);
  const result = scanHintFiles(packageRoot, files);

  it("reads the sources of the tool and its build script", () => {
    const relative = files.map((file) => path.relative(packageRoot, file).split(path.sep).join("/"));
    expect(relative).toContain("src/cli/Hints.ts");
    expect(relative).toContain("src/scripts/Cli.ts");
    expect(relative).toContain("native/build.js");
  });

  it("finds the command lines of the hints and parses them", () => {
    expect(result.checked).toBeGreaterThan(20);
  });

  it("finds every command line quoted and accepted by the parser", () => {
    expect(describeFindings(result.findings)).toEqual([]);
  });

  it("finds no mention of the removed commands", () => {
    const text = files.map((file) => fs.readFileSync(file, "utf-8")).join("\n");
    expect(text).not.toContain("config add-scope");
    expect(text).not.toContain("config edit'");
  });
});

describe("self-test", () => {
  it("reports a quoted command line that the parser rejects and an unquoted one", () => {
    const fixture = [
      "const a = \"Run \\\"the-seed config add-scope\\\" first.\";",
      "const b = \"Then run the-seed build native here.\";",
    ].join("\n");
    const result = scanHintText(fixture, "fixture.ts");
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ file: "fixture.ts", line: 1 });
    expect(result.findings[0].reason).toContain("config");
    expect(result.findings[1]).toMatchObject({ file: "fixture.ts", line: 2, reason: "command line not quoted" });
  });

  it("reports single-quoted command lines and lines split by concatenation", () => {
    const fixture = [
      "const a = \"Run 'the-seed signing sign' to replace it\";",
      "const b = \"Install it with \\\"the-seed build \" + target + \"\\\" again\";",
    ].join("\n");
    const result = scanHintText(fixture, "fixture.ts");
    expect(result.findings.map((finding) => [finding.line, finding.reason])).toEqual([
      [1, "command line not quoted"],
      [2, "command line not quoted"],
    ]);
  });

  it("accepts quoted command lines with placeholders and template expressions", () => {
    const fixture = [
      "const a = `Create one with \"the-seed signing create-cert --scope ${outcome.scope}\".`;",
      "const b = \"Sign it with \\\"the-seed signing sign <path>\\\".\";",
      "const c = \"Run \\\"the-seed help <command> <subcommand>\\\" for details.\";",
      "const d = \"\\\"the-seed build [--jobs <n>]\\\" rebuilds\";",
    ].join("\n");
    const result = scanHintText(fixture, "fixture.ts");
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(4);
  });

  it("accepts a literal that is one command line and rejects one the parser does not accept", () => {
    const fixture = [
      "const a = \"the-seed build native\";",
      "const b = \"the-seed build mac\";",
    ].join("\n");
    const result = scanHintText(fixture, "fixture.ts");
    expect(result.checked).toBe(2);
    expect(result.findings.map((finding) => finding.line)).toEqual([2]);
  });

  it("reports an unknown placeholder and a subcommand placeholder without a command", () => {
    expect(checkCommandLine("signing sign <nonsense>")).toContain("unknown placeholder");
    expect(checkCommandLine("help <subcommand>")).toContain("unknown placeholder");
  });

  it("ignores comments, library names, paths and file names", () => {
    const fixture = [
      "// Run the-seed build native from here",
      "/* the-seed signing sign */",
      "const a = \"libthe-seed and @metaverse-systems/the-seed and ~/the-seed/config.json and /usr/the-seed build\";",
      "const b = \"the-seed.js and the-seed.ts\";",
      "const c = \"http://example.org/the-seed\"; // the-seed build",
    ].join("\n");
    expect(scanHintText(fixture, "fixture.ts")).toEqual({ findings: [], checked: 0 });
  });
});

describe("following a hint", () => {
  const created: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  interface Home {
    home: string;
    configDir: string;
    cwd: string;
  }

  /** A scratch home whose configuration has the given scopes (scope to author name; "" is no name). */
  function makeHome(scopes: Record<string, string>): Home {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "hint-home-"));
    created.push(home);
    const configDir = path.join(home, "the-seed");
    fs.mkdirSync(configDir, { recursive: true });
    const config: Record<string, { author: { name: string; email: string; url: string } }> = {};
    for (const [scope, name] of Object.entries(scopes)) {
      config[scope] = { author: { name, email: "", url: "" } };
    }
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(home, "prefix"), scopes: config }, null, 2));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hint-cwd-"));
    created.push(cwd);
    return { home, configDir, cwd };
  }

  function run(args: string[], env: Home, options: { answers?: unknown[]; interactive?: boolean } = {}): Promise<RunResult> {
    return runTheSeed(args, { home: env.home, configDir: env.configDir, cwd: env.cwd, ...options });
  }

  /** The words after `the-seed` of the first command line a hint quotes. */
  function quotedCommand(hint: string): string[] {
    const match = /"the-seed ([^"]+)"/.exec(hint);
    if (match === null) throw new Error("the hint quotes no command line: " + hint);
    return match[1].split(" ");
  }

  function configuredScopes(env: Home): Record<string, { author: { name: string } }> {
    return JSON.parse(fs.readFileSync(path.join(env.configDir, "config.json"), "utf-8")).scopes;
  }

  function certificate(env: Home, scope: string): string {
    return path.join(env.configDir, "signing", scope, "cert.pem");
  }

  function sampleBinary(env: Home): string {
    const file = path.join(env.cwd, "tiny-macho-arm64");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
    return file;
  }

  it("no scopes: create-cert prints the add-scope hint, and running it adds the scope", async () => {
    const env = makeHome({});
    const failed = await run(["signing", "create-cert"], env);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain(addScopeHint());

    const answers = [{ scopeName: "@b", authorName: "Bee", authorEmail: "bee@example.com", authorURL: "" }];
    const followed = await run(quotedCommand(addScopeHint()), env, { answers });
    expect(followed.status).toBe(0);
    expect(configuredScopes(env)["@b"].author.name).toBe("Bee");
  });

  it("a scope without an author name: create-cert prints the edit hint, and running it sets the name", async () => {
    const env = makeHome({ "@b": "" });
    const failed = await run(["signing", "create-cert", "--scope", "@b"], env);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain(editScopeHint("@b"));
    expect(fs.existsSync(certificate(env, "@b"))).toBe(false);

    const answers = [{ scopeName: "@b" }, { authorName: "Bee", authorEmail: "", authorURL: "" }];
    const edited = await run(quotedCommand(editScopeHint("@b")), env, { answers });
    expect(edited.status).toBe(0);
    expect(configuredScopes(env)["@b"].author.name).toBe("Bee");

    const created = await run(["signing", "create-cert", "--scope", "@b"], env, { interactive: false });
    expect(created.status).toBe(0);
    expect(fs.existsSync(certificate(env, "@b"))).toBe(true);
  });

  it("no certificate for the scope: sign prints the create hint, and running it creates the certificate without a prompt", async () => {
    const env = makeHome({ "@a": "Aye", "@b": "Bee" });
    const failed = await run(["signing", "sign", sampleBinary(env), "--scope", "@a"], env);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain(createCertHint("@a"));

    const followed = await run(quotedCommand(createCertHint("@a")), env, { interactive: false });
    expect(followed.status).toBe(0);
    expect(followed.prompts).toEqual([]);
    expect(fs.existsSync(certificate(env, "@a"))).toBe(true);
    expect(fs.existsSync(certificate(env, "@b"))).toBe(false);
  });

  it("an expired certificate: sign prints the replace hint, and running it replaces the certificate", async () => {
    const env = makeHome({ "@a": "Aye", "@b": "Bee" });
    await new Signing(env.configDir).createCert({ scope: "@a" });
    const before = fs.readFileSync(certificate(env, "@a"), "utf-8");
    const original = Signing.prototype.getCertInfo;
    const spy = jest.spyOn(Signing.prototype, "getCertInfo").mockImplementation(function (this: Signing, scope: string) {
      const info = original.call(this, scope);
      return info === null ? null : { ...info, isExpired: true };
    });
    const failed = await run(["signing", "sign", sampleBinary(env), "--scope", "@a"], env);
    expect(failed.status).toBe(2);
    expect(failed.stderr).toContain(replaceCertHint("@a"));
    spy.mockRestore();

    const followed = await run(quotedCommand(replaceCertHint("@a")), env, { interactive: false });
    expect(followed.status).toBe(0);
    expect(followed.prompts).toEqual([]);
    expect(fs.readFileSync(certificate(env, "@a"), "utf-8")).not.toBe(before);
  });

  it("config scopes list: the usage error prints the list hint, and running it succeeds", async () => {
    const env = makeHome({ "@a": "Aye" });
    const failed = await run(["config", "scopes", "list"], env);
    expect(failed.status).toBe(3);
    expect(failed.stderr).toContain(listScopesHint());

    const followed = await run(quotedCommand(listScopesHint()), env);
    expect(followed.status).toBe(0);
    expect(followed.stdout).toContain("@a");
  });

  it.each([
    [["bogus"]],
    [["signing", "bogus"]],
    [["scopes", "bogus"]],
    [["build", "native", "--bogus"]],
    [["signing", "sign", "--bogus"]],
    [["signing", "create-cert", "--validity-days"]],
    [["package", "--jobs"]],
    [["config", "scopes", "list"]],
  ])("the help hint of the usage error of %j runs with status 0", async (args) => {
    const env = makeHome({ "@a": "Aye" });
    const failed = await run(args, env);
    expect(failed.status).toBe(3);
    const lines = failed.stderr.trimEnd().split("\n");
    const hint = lines[lines.length - 1];
    expect(hint).toMatch(/^Run "the-seed help[^"]*" for details\.$/);

    const followed = await run(quotedCommand(hint), env);
    expect(followed.status).toBe(0);
    expect(followed.stdout).not.toBe("");
    expect(followed.stderr).toBe("");
  });
});
