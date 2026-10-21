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
 * - `build` prints `Built <dir>/<name>.pak (<n> resources, <bytes> bytes)` on standard output, where
 *   `<bytes>` is the size of the whole pak file, and nothing on standard error. A refusal is one `Error:`
 *   line followed by the hint line when there is one, and nothing on standard output.
 * - `add` prints `Added <name> (<filename>, <n> bytes) to <pak name>` on standard output, `<filename>` being the
 *   path as recorded in the description and `<n>` the file's size, and nothing on standard error. A refusal is
 *   one `Error:` line followed by the hint line when there is one, and nothing on standard output. `add` acts
 *   on the working directory; a file is named relative to it.
 * - `add --attribute <key>=<value>` (repeatable) records the attributes as an object in the order given, on the
 *   entry in `package.json`; the success line is the same as without them. A malformed or repeated attribute is a
 *   usage error: status 3, nothing on standard output and exactly three lines on standard error (`Error: <message>`,
 *   the usage line of `add`, the help hint), given before the project or the file is read, so the working
 *   directory is unchanged.
 * - The three cases of an invalid project directory that used to be in the exit status tests are
 *   kept here with their assertions unchanged.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { runTheSeed, snapshotTree, RunResult } from "./helpers/RunCli";
import { validateProjectName } from "../src/ProjectName";
import { createPakHint } from "../src/cli/Hints";
import { fileDigest } from "./helpers/NativeAbsent";

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
    const env = makeEnv();
    const run = await exec(["resource-pak", "build"], env);
    expect(run.status).toBe(2);
    expect(errorLines(run)).toHaveLength(1);
    expect(run.stderr).toContain(`Error: ${env.cwd} is not a resource pak project: no package.json.`);
    expect(run.stderr).not.toContain("Unexpected error");
  });

  it("resource-pak add with a file that does not exist is 2 and leaves the project description unchanged", async () => {
    const env = makeEnv({ "@t": "T Author" });
    await exec(["resource-pak", "create", "@t/pak"], env);
    const project = path.join(env.cwd, "pak");
    const description = fs.readFileSync(path.join(project, "package.json"), "utf-8");
    const run = await runTheSeed(["resource-pak", "add", "x", "missing.dat"], {
      home: env.home, configDir: env.configDir, cwd: project, interactive: false,
    });
    expect(run.status).toBe(2);
    expect(errorLines(run)).toHaveLength(1);
    expect(fs.readFileSync(path.join(project, "package.json"), "utf-8")).toBe(description);
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

describe("resource-pak build", () => {
  const author = "T Author";
  const hint = createPakHint();

  /** A scratch environment whose working directory is a created pak project with the given files added. */
  async function projectWith(files: Record<string, string>): Promise<Env & { project: string }> {
    const env = makeEnv({ "@t": author });
    await exec(["resource-pak", "create", "@t/sounds"], env);
    const project = path.join(env.cwd, "sounds");
    for (const file of Object.keys(files)) {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), files[file]);
      const added = await runTheSeed(["resource-pak", "add", file, file], {
        home: env.home, configDir: env.configDir, cwd: project, interactive: false,
      });
      expect(added.status).toBe(0);
    }
    return { ...env, project };
  }

  const build = (env: Env & { project: string }): Promise<RunResult> =>
    runTheSeed(["resource-pak", "build"], { home: env.home, configDir: env.configDir, cwd: env.project, interactive: false });

  it("prints the pak path, the resource count and the pak's size, and exits 0", async () => {
    const env = await projectWith({ "a.txt": "abc", "music/b.dat": "0123456789" });

    const run = await build(env);

    const pak = path.join(env.project, "sounds.pak");
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(`Built ${pak} (2 resources, ${fs.statSync(pak).size} bytes)\n`);
  });

  it("with no resources builds an empty pak and exits 0", async () => {
    const env = await projectWith({});

    const run = await build(env);

    expect(run.status).toBe(0);
    expect(run.stdout).toBe(`Built ${path.join(env.project, "sounds.pak")} (0 resources, ${fs.statSync(path.join(env.project, "sounds.pak")).size} bytes)\n`);
  });

  it("where package.json has no resources list is 2 with the not-a-project message and the create hint", async () => {
    const env = makeEnv({ "@t": author });
    fs.writeFileSync(path.join(env.cwd, "package.json"), JSON.stringify({ name: "@t/thing", version: "1.0.0" }));
    const before = snapshotTree(env.home);

    const run = await exec(["resource-pak", "build"], env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Error: ${env.cwd} is not a resource pak project: package.json has no "resources" list.\n${hint}\n`);
    expect(run.stderr).not.toContain("Unexpected error");
    expect(snapshotTree(env.home)).toEqual(before);
  });

  it("with no package.json is 2 saying there is no package.json, with the create hint", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "build"], env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Error: ${env.cwd} is not a resource pak project: no package.json.\n${hint}\n`);
  });

  it("with a package.json that is not JSON is 2 naming the parser's message", async () => {
    const env = makeEnv({ "@t": author });
    fs.writeFileSync(path.join(env.cwd, "package.json"), "{ nope");

    const run = await exec(["resource-pak", "build"], env);

    expect(run.status).toBe(2);
    expect(run.stderr).toContain(`Error: ${env.cwd} is not a resource pak project: package.json is not valid JSON (`);
    expect(errorLines(run)).toHaveLength(1);
    expect(run.stderr).toContain(hint);
  });

  it("with a missing resource file is 2 naming the resource and the file, the existing pak unchanged", async () => {
    const env = await projectWith({ "music/theme.ogg": "ogg data" });
    expect((await build(env)).status).toBe(0);
    const pak = path.join(env.project, "sounds.pak");
    const before = fileDigest(pak);
    const description = fs.readFileSync(path.join(env.project, "package.json"));
    fs.rmSync(path.join(env.project, "music", "theme.ogg"));

    const run = await build(env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("Error: Resource \"music/theme.ogg\" refers to music/theme.ogg, which is missing.\n");
    expect(fileDigest(pak)).toBe(before);
    expect(fs.readFileSync(path.join(env.project, "package.json")).equals(description)).toBe(true);
    expect(fs.readdirSync(env.project).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  /** Builds once, applies a change to the project, builds again and checks the refusal left everything as it was. */
  async function refusedAfter(
    files: Record<string, string>, change: (project: string) => void, status: number, stderr: string
  ): Promise<void> {
    const env = await projectWith(files);
    expect((await build(env)).status).toBe(0);
    const pak = path.join(env.project, "sounds.pak");
    const before = fileDigest(pak);
    change(env.project);

    const run = await build(env);

    expect(run.status).toBe(status);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(stderr);
    expect(fileDigest(pak)).toBe(before);
    expect(fs.readdirSync(env.project).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  }

  const editResources = (project: string, edit: (resources: Array<Record<string, unknown>>) => void): void => {
    const file = path.join(project, "package.json");
    const description = JSON.parse(fs.readFileSync(file, "utf8")) as { resources: Array<Record<string, unknown>> };
    edit(description.resources);
    fs.writeFileSync(file, JSON.stringify(description, null, 2));
  };

  it("with a resource file that is a directory is 2 saying it is not a file, the existing pak unchanged", async () => {
    await refusedAfter({ "theme.ogg": "ogg" }, (project) => {
      fs.rmSync(path.join(project, "theme.ogg"));
      fs.mkdirSync(path.join(project, "theme.ogg"));
    }, 2, "Error: Resource \"theme.ogg\" refers to theme.ogg, which is not a file.\n");
  });

  it("with a resource file outside the project is 2 saying so, the existing pak unchanged", async () => {
    await refusedAfter({ "theme.ogg": "ogg" }, (project) => {
      fs.writeFileSync(path.join(path.dirname(project), "outside.dat"), "outside");
      editResources(project, (resources) => { resources[0].filename = "../outside.dat"; });
    }, 2, "Error: Resource \"theme.ogg\" refers to ../outside.dat, which is outside the project.\n");
  });

  it("with a resource name that is not well-formed Unicode is 2 naming the resource's index", async () => {
    await refusedAfter({ "theme.ogg": "ogg" }, (project) => {
      editResources(project, (resources) => { resources[0].name = "bad\ud800name"; });
    }, 2, "Error: Resource 0 has a name that is not valid Unicode text.\n");
  });

  it("with two entries of one name in package.json is 2 naming the resource", async () => {
    await refusedAfter({ "a.txt": "a", "b.txt": "b" }, (project) => {
      editResources(project, (resources) => { resources[1].name = resources[0].name; });
    }, 2, "Error: Resource \"a.txt\" appears more than once in package.json.\n");
  });

  (typeof process.getuid === "function" && process.getuid() !== 0 ? it : it.skip)(
    "in a directory that cannot be written is 1 with the path and the system's reason, the existing pak unchanged",
    async () => {
      const env = await projectWith({ "theme.ogg": "ogg" });
      expect((await build(env)).status).toBe(0);
      const pak = path.join(env.project, "sounds.pak");
      const before = fileDigest(pak);
      fs.chmodSync(env.project, 0o555);
      try {
        const run = await build(env);

        expect(run.status).toBe(1);
        expect(run.stdout).toBe("");
        expect(errorLines(run)).toHaveLength(1);
        expect(run.stderr).toMatch(/^Error: Cannot write .+: .+\n$/);
      } finally {
        fs.chmodSync(env.project, 0o755);
      }
      expect(fileDigest(pak)).toBe(before);
    }
  );
});

describe("resource-pak add", () => {
  const author = "T Author";
  const hint = createPakHint();

  /** A scratch environment with a created pak project `@t/sounds` and the given files in it, nothing added yet. */
  function projectWith(files: Record<string, string>): Promise<Env & { project: string }> {
    const env = makeEnv({ "@t": author });
    return exec(["resource-pak", "create", "@t/sounds"], env).then(() => {
      const project = path.join(env.cwd, "sounds");
      for (const file of Object.keys(files)) {
        fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
        fs.writeFileSync(path.join(project, file), files[file]);
      }
      return { ...env, project };
    });
  }

  const add = (env: Env & { project: string }, ...words: string[]): Promise<RunResult> =>
    runTheSeed(["resource-pak", "add", ...words], { home: env.home, configDir: env.configDir, cwd: env.project, interactive: false });

  const description = (env: Env & { project: string }): string =>
    fs.readFileSync(path.join(env.project, "package.json"), "utf-8");

  const entries = (env: Env & { project: string }): Array<{ name: string; filename: string; size: number }> =>
    JSON.parse(description(env)).resources;

  it("prints the name, the file, its size and the pak, and exits 0", async () => {
    const env = await projectWith({ "music/theme.ogg": "ogg data" });

    const run = await add(env, "theme", "music/theme.ogg");

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("Added theme (music/theme.ogg, 8 bytes) to @t/sounds\n");
    expect(entries(env)).toEqual([{ name: "theme", filename: "music/theme.ogg", size: 8 }]);
  });

  it("a duplicate is 1 with the message, the replace hint and package.json unchanged", async () => {
    const env = await projectWith({ "music/theme.ogg": "ogg data", "other.ogg": "other" });
    expect((await add(env, "theme", "music/theme.ogg")).status).toBe(0);
    const before = description(env);

    const run = await add(env, "theme", "other.ogg");

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "Error: Resource \"theme\" already exists in @t/sounds; it refers to music/theme.ogg.\n" +
      "Give --force to replace it.\n");
    expect(description(env)).toBe(before);
  });

  it("with --force replaces the entry where it stands, exits 0 and prints the usual line", async () => {
    const env = await projectWith({ "music/theme.ogg": "ogg data", "a.txt": "a", "other.ogg": "other data" });
    await add(env, "theme", "music/theme.ogg");
    await add(env, "last", "a.txt");

    const run = await add(env, "theme", "other.ogg", "--force");

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("Added theme (other.ogg, 10 bytes) to @t/sounds\n");
    expect(entries(env)).toEqual([
      { name: "theme", filename: "other.ogg", size: 10 },
      { name: "last", filename: "a.txt", size: 1 },
    ]);
  });

  it("--attribute records the attributes in the order given, an = in a value and an empty value included", async () => {
    const env = await projectWith({ "music/theme.ogg": "ogg data" });

    const run = await add(env, "theme", "music/theme.ogg",
      "--attribute", "type=audio", "--attribute", "expr=a=b", "--attribute", "note=");

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("Added theme (music/theme.ogg, 8 bytes) to @t/sounds\n");
    const recorded = JSON.parse(description(env)).resources;
    expect(recorded).toEqual([
      { name: "theme", filename: "music/theme.ogg", size: 8, attributes: { type: "audio", expr: "a=b", note: "" } },
    ]);
    expect(Object.keys(recorded[0].attributes)).toEqual(["type", "expr", "note"]);
  });

  it("--attribute=key=value is accepted and an entry without attributes has none", async () => {
    const env = await projectWith({ "a.ogg": "a", "b.ogg": "b" });

    expect((await add(env, "one", "a.ogg", "--attribute=type=audio")).status).toBe(0);
    expect((await add(env, "two", "b.ogg")).status).toBe(0);

    const recorded = JSON.parse(description(env)).resources;
    expect(recorded[0].attributes).toEqual({ type: "audio" });
    expect(recorded[1]).not.toHaveProperty("attributes");
  });

  it("--force with --attribute replaces the entry and its attributes", async () => {
    const env = await projectWith({ "a.ogg": "a", "b.ogg": "bb" });
    await add(env, "theme", "a.ogg", "--attribute", "type=audio", "--attribute", "loop=true");

    const run = await add(env, "theme", "b.ogg", "--force", "--attribute", "volume=3");

    expect(run.status).toBe(0);
    expect(JSON.parse(description(env)).resources).toEqual([
      { name: "theme", filename: "b.ogg", size: 2, attributes: { volume: "3" } },
    ]);
  });

  describe("a refused --attribute is a usage error before anything is read", () => {
    const usageLine =
      "Usage: the-seed resource-pak add <resource-name> <filename> [--attribute <key>=<value>]... [--force]";
    const hintLine = "Run \"the-seed help resource-pak add\" for details.";

    it.each([
      [["--attribute", "loop"], "Invalid value \"loop\" for --attribute; expected <key>=<value>, such as type=audio."],
      [["--attribute", "=x"], "Invalid value \"=x\" for --attribute; the key before \"=\" cannot be empty."],
      [["--attribute", "loop=1", "--attribute", "loop=2"], "--attribute \"loop\" is given twice; give each key once."],
      [["--attribute", "a=1", "--attribute", "b=2", "--attribute=a="], "--attribute \"a\" is given twice; give each key once."],
    ])("%j", async (words, message) => {
      const env = await projectWith({ "music/theme.ogg": "ogg data" });
      const before = description(env);
      const tree = snapshotTree(env.cwd);

      const run = await add(env, "theme", "music/theme.ogg", ...words);

      expect(run.status).toBe(3);
      expect(run.stdout).toBe("");
      expect(run.stderr).toBe(`Error: ${message}\n${usageLine}\n${hintLine}\n`);
      expect(description(env)).toBe(before);
      expect(snapshotTree(env.cwd)).toEqual(tree);
    });

    it("is given before the project is looked at: outside a pak project it is still 3", async () => {
      const env = makeEnv({ "@t": author });
      const tree = snapshotTree(env.cwd);

      const run = await exec(["resource-pak", "add", "theme", "missing.ogg", "--attribute", "loop"], env);

      expect(run.status).toBe(3);
      expect(run.stderr.split("\n").filter((line) => line !== "")).toHaveLength(3);
      expect(snapshotTree(env.cwd)).toEqual(tree);
    });
  });

  it("a missing file is 2 naming the file, package.json unchanged", async () => {
    const env = await projectWith({});
    const before = description(env);

    const run = await add(env, "theme", "nope.ogg");

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Error: File not found: ${path.join(env.project, "nope.ogg")}\n`);
    expect(description(env)).toBe(before);
  });

  it("a directory is 2 saying it is not a file, package.json unchanged", async () => {
    const env = await projectWith({ "music/a.txt": "a" });
    const before = description(env);

    const run = await add(env, "theme", "music");

    expect(run.status).toBe(2);
    expect(run.stderr).toBe(`Error: ${path.join(env.project, "music")} is not a file.\n`);
    expect(description(env)).toBe(before);
  });

  it("a file outside the project is 2 asking to copy it in, package.json unchanged", async () => {
    const env = await projectWith({});
    const outside = path.join(env.cwd, "outside.txt");
    fs.writeFileSync(outside, "x");
    const before = description(env);

    const run = await add(env, "theme", "../outside.txt");

    expect(run.status).toBe(2);
    expect(run.stderr).toBe(
      `Error: ${outside} is outside the resource pak project ${env.project}; copy the file into the project first.\n`);
    expect(description(env)).toBe(before);
  });

  it("outside a pak project is 2 with the create hint and package.json unchanged", async () => {
    const env = makeEnv({ "@t": author });
    const text = JSON.stringify({ name: "@t/thing", version: "1.0.0" });
    fs.writeFileSync(path.join(env.cwd, "package.json"), text);
    fs.writeFileSync(path.join(env.cwd, "a.txt"), "a");

    const run = await exec(["resource-pak", "add", "a", "a.txt"], env);

    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(`Error: ${env.cwd} is not a resource pak project: package.json has no "resources" list.\n${hint}\n`);
    expect(fs.readFileSync(path.join(env.cwd, "package.json"), "utf-8")).toBe(text);
  });

  it("with no package.json is 2 saying so, with the create hint", async () => {
    const env = makeEnv({ "@t": author });

    const run = await exec(["resource-pak", "add", "a", "a.txt"], env);

    expect(run.status).toBe(2);
    expect(run.stderr).toBe(`Error: ${env.cwd} is not a resource pak project: no package.json.\n${hint}\n`);
  });
});
