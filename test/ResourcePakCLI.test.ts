/*
 * Tests for the `resource-pak` command, run in-process through `runTheSeed` with scratch homes and
 * working directories.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - The creation message printed by `create` is `Created resource pak <scope>/<name> in ./<name>`
 *   on standard output, and nothing else is printed.
 * - Without the argument `create` asks one list of two questions, `scopeName` and `pakName`; the
 *   question `pakName` carries `validate(input)`, which returns `true` for a usable name and the
 *   reason (the text `validateProjectName` gives for a resource pak) otherwise.
 * - A refused name on the command line is a usage error naming `<scope>/<name>` (status 3), given
 *   before anything is prompted or written.
 * - The three cases of an invalid project directory that used to be in the exit status tests are
 *   kept here with their assertions unchanged.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runTheSeed, snapshotTree, RunResult } from "./helpers/RunCli";
import { validateProjectName } from "../src/ProjectName";

interface Env {
  home: string;
  configDir: string;
  prefix: string;
  cwd: string;
}

const created: string[] = [];

function makeEnv(scopes: Record<string, string> = {}): Env {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pak-cli-"));
  created.push(home);
  const configDir = path.join(home, "the-seed");
  const prefix = path.join(home, "prefix");
  const cwd = path.join(home, "work");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cwd);
  const body: Record<string, { author: { name: string; email: string; url: string } }> = {};
  for (const scope of Object.keys(scopes)) {
    body[scope] = { author: { name: scopes[scope], email: "author@example.com", url: "" } };
  }
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: body }, null, 2));
  return { home, configDir, prefix, cwd };
}

function exec(args: string[], env: Env, answers?: unknown[]): Promise<RunResult> {
  return runTheSeed(args, {
    home: env.home,
    configDir: env.configDir,
    cwd: env.cwd,
    interactive: answers !== undefined,
    answers,
  });
}

/** The lines of standard error that start with "Error:". */
function errorLines(run: RunResult): string[] {
  return run.stderr.split("\n").filter((line) => line.startsWith("Error:"));
}

afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("configuration and project", () => {
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

describe("resource-pak create", () => {
  const author = "T Author";

  it("create @t/sounds creates ./sounds without a prompt and prints one line", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "create", "@t/sounds"], env);

    expect(run.status).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(run.stdout).toBe("Created resource pak @t/sounds in ./sounds\n");
    expect(run.stderr).toBe("");
    expect(fs.readdirSync(env.cwd)).toEqual(["sounds"]);
    expect(fs.readdirSync(path.join(env.cwd, "sounds"))).toEqual(["package.json"]);
    const description = JSON.parse(fs.readFileSync(path.join(env.cwd, "sounds", "package.json"), "utf-8"));
    expect(description.name).toBe("@t/sounds");
    expect(description.author).toEqual({ name: author, email: "author@example.com" });
    expect(description.resources).toEqual([]);
    expect(fs.existsSync(path.join(env.prefix, "projects"))).toBe(false);
  });

  it("create t/sounds (without the @) is the scope @t", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "create", "t/sounds"], env);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("Created resource pak @t/sounds in ./sounds\n");
  });

  it("create alone asks for the scope and the name and creates ./<name>", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "create"], env, [{ scopeName: "@t", pakName: "sounds" }]);

    expect(run.status).toBe(0);
    expect(run.prompts).toHaveLength(1);
    expect(run.stdout).toBe("Created resource pak @t/sounds in ./sounds\n");
    expect(fs.existsSync(path.join(env.cwd, "sounds", "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(env.prefix, "projects"))).toBe(false);
  });

  it("the name question validates with the resource pak rule", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "create"], env, [{ scopeName: "@t", pakName: "sounds" }]);

    const questions = run.prompts[0] as Array<{ name: string; validate?: (input: string) => string | boolean }>;
    expect(questions.map((question) => question.name)).toEqual(["scopeName", "pakName"]);
    const validate = questions[1].validate;
    expect(typeof validate).toBe("function");
    const check = validate as (input: string) => string | boolean;
    expect(check("3d")).toBe(validateProjectName("3d", "resource-pak"));
    expect(typeof check("3d")).toBe("string");
    expect(typeof check("Hello")).toBe("string");
    expect(typeof check("")).toBe("string");
    expect(check("class")).toBe(true);
    expect(check("mesh.loader")).toBe(true);
    expect(check("sounds")).toBe(true);
  });

  it("create @t/3d is a usage error naming <scope>/<name>, with nothing prompted or created", async () => {
    const env = makeEnv({ "@t": author });
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "create", "@t/3d"], env);

    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`Error: Invalid value "@t/3d" for <scope>/<name>; ${validateProjectName("3d", "resource-pak")}`);
    expect(run.prompts).toEqual([]);
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("create @t/class is accepted: the identifier rules of code projects do not apply", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "create", "@t/class"], env);

    expect(run.status).toBe(0);
    expect(fs.existsSync(path.join(env.cwd, "class", "package.json"))).toBe(true);
  });

  it("create with an extra word is a usage error and creates nothing", async () => {
    const env = makeEnv({ "@t": author });
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "create", "@t/a", "@t/b"], env);

    expect(run.status).toBe(3);
    expect(run.stderr).toContain("Unexpected argument");
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("a scope that is not configured is 2 as for template, with nothing created", async () => {
    const env = makeEnv({ "@t": author });
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "create", "@nope/x"], env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Error: Scope \"@nope\" is not configured. Configured scopes: @t.");
    expect(errorLines(run)).toHaveLength(1);
    expect(run.stderr).not.toContain("Unexpected error");
    expect(run.prompts).toEqual([]);
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("an author without a name is 2 with the scopes edit hint and nothing created", async () => {
    const env = makeEnv({ "@anon": "" });
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "create", "@anon/sounds"], env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "Error: Required author name is missing for scope '@anon'.\n" +
      "Set the author's name with \"the-seed scopes edit\" (scope @anon).\n");
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("an existing ./sounds is 1 with the path in the message and its contents unchanged", async () => {
    const env = makeEnv({ "@t": author });
    fs.mkdirSync(path.join(env.cwd, "sounds"));
    fs.writeFileSync(path.join(env.cwd, "sounds", "mine.txt"), "keep me\n");
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "create", "@t/sounds"], env);

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`Error: ${path.join(env.cwd, "sounds")} already exists; nothing was created.`);
    expect(errorLines(run)).toHaveLength(1);
    expect(run.stderr).not.toContain("Unexpected error");
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("the created project is accepted by add and build in its own directory", async () => {
    const env = makeEnv({ "@t": author });
    await exec(["resource-pak", "create", "@t/sounds"], env);
    const project = path.join(env.cwd, "sounds");
    fs.writeFileSync(path.join(project, "a.txt"), "abc");

    const added = await runTheSeed(["resource-pak", "add", "a", "a.txt"], {
      home: env.home, configDir: env.configDir, cwd: project, interactive: false,
    });
    const built = await runTheSeed(["resource-pak", "build"], {
      home: env.home, configDir: env.configDir, cwd: project, interactive: false,
    });

    expect(added.status).toBe(0);
    expect(built.status).toBe(0);
    expect(fs.existsSync(path.join(project, "sounds.pak"))).toBe(true);
  });
});
