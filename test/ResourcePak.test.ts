/*
 * Tests for the resource pak project library.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - `ResourcePak.createPackage(scope, name, parentDir?)` returns the absolute path of the new
 *   project (`<parentDir>/<name>`, the current directory when `parentDir` is left out). The tests
 *   reach it through a cast so that this file still compiles while the signature is the old one.
 * - A refusal is an `Error` whose `name` is "ProjectError" and which carries `code` and `hint`;
 *   it is recognised by name so that no static import of the class is needed.
 * - The project description is compared as text with the specified one: two-space indentation, a
 *   final newline, an empty email or web address left out.
 * - `ResourcePak.readProject(dir)` and `build(dir)` (which returns the pak path) are reached through casts, so
 *   that this file compiles while the signatures are the old ones. A refusal of `readProject` has the code
 *   "not-pak-project", the message `<dir> is not a resource pak project: <rule>.` and the hint `createPakHint()`.
 *   The rules the contract gives in words (no package.json, not valid JSON with the parser's first line, no
 *   "resources" list, "name" not of the form @scope/name) are asserted exactly; for the others (unreadable, not an
 *   object, entry without a name or filename, attributes not strings) the message must name the directory and the
 *   field concerned.
 * - A failure while the pak is written is simulated by replacing the resource file with a directory the first time
 *   it is opened (spies on `openSync` of both `fs` and `fs-extra`), or by a read-only project directory (skipped
 *   when the tests run as root). A file that changes while it is copied is simulated by making the first
 *   `readSync` of the resource file return one byte fewer than it read (spies on both modules; only reads of the
 *   descriptor opened for that file count, because Node reads package.json through `fs.readSync` too).
 * - The message for a resource name that is not valid Unicode is matched with any index, `Resource <n> has ...`.
 * - Cases that create a project run with `HOME` set to a scratch directory, so that a program
 *   started on the way (the package manager) would leave its traces there, where they are looked for.
 */
import fs from "fs";
import os from "os";
import path from "path";
import fsExtra from "fs-extra";
import ResourcePak from "../src/ResourcePak";
import Config from "../src/Config";
import { createPakHint } from "../src/cli/Hints";
import { projectErrorStatus } from "../src/cli/ExitStatus";
import { ProjectErrorCode } from "../src/ProjectError";
import { snapshotTree } from "./helpers/RunCli";
import { fileDigest } from "./helpers/NativeAbsent";

type CreatePackage = (scope: string, name: string, parentDir?: string) => string;

interface ProjectErrorShape extends Error {
  code: string;
  hint?: string;
}

// Helper to create a temporary directory for testing
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "resource-pak-"));
}

describe("ResourcePak", () => {
  let tempDir: string;
  let parentDir: string;
  let scratchHome: string;
  let savedHome: string | undefined;
  let config: Config;
  let rp: ResourcePak;

  const writeConfig = (scopes: Record<string, { name: string; email: string; url: string }>): void => {
    const body: Record<string, { author: { name: string; email: string; url: string } }> = {};
    for (const scope of Object.keys(scopes)) {
      body[scope] = { author: scopes[scope] };
    }
    fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ prefix: tempDir, scopes: body }));
    config = new Config(tempDir);
    rp = new ResourcePak(config);
  };

  const create = (scope: string, name: string, dir: string = parentDir): string =>
    (rp.createPackage as unknown as CreatePackage)(scope, name, dir);

  /** Creates the project and returns its path, with the configured scope `@test`. */
  const createPak = (name: string): string => create("@test", name);

  const refusal = (action: () => unknown): ProjectErrorShape => {
    let caught: unknown;
    try {
      action();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error) || caught.name !== "ProjectError") {
      throw new Error("expected a ProjectError but got " + String(caught));
    }
    return caught as ProjectErrorShape;
  };

  const readDescription = (dir: string): { resources?: Array<{ name: string; filename: string; size: number }> } & Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, "package.json")).toString());

  beforeEach(() => {
    tempDir = createTempDir();
    parentDir = path.join(tempDir, "work");
    fs.mkdirSync(parentDir);
    scratchHome = path.join(tempDir, "home");
    fs.mkdirSync(scratchHome);
    savedHome = process.env.HOME;
    process.env.HOME = scratchHome;
    writeConfig({ "@test": { name: "Test Author", email: "test@test.com", url: "" } });
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    fs.rmSync(tempDir, { recursive: true });
  });

  describe("createPackage", () => {
    it("creates <parentDir>/<name>/package.json as specified and returns the project path", () => {
      const result = createPak("my-pak");

      expect(result).toBe(path.join(parentDir, "my-pak"));
      expect(path.isAbsolute(result)).toBe(true);
      expect(fs.readFileSync(path.join(result, "package.json")).toString()).toBe(
        "{\n" +
        "  \"name\": \"@test/my-pak\",\n" +
        "  \"version\": \"0.0.1\",\n" +
        "  \"author\": {\n" +
        "    \"name\": \"Test Author\",\n" +
        "    \"email\": \"test@test.com\"\n" +
        "  },\n" +
        "  \"license\": \"UNLICENSED\",\n" +
        "  \"scripts\": {\n" +
        "    \"build\": \"the-seed resource-pak build\"\n" +
        "  },\n" +
        "  \"resources\": []\n" +
        "}\n");
    });

    it("writes the email and web address when the author has them", () => {
      writeConfig({ "@acme": { name: "Ada Lovelace", email: "ada@example.com", url: "https://acme.example" } });

      const result = create("@acme", "sounds");

      expect(fs.readFileSync(path.join(result, "package.json")).toString()).toBe(
        "{\n" +
        "  \"name\": \"@acme/sounds\",\n" +
        "  \"version\": \"0.0.1\",\n" +
        "  \"author\": {\n" +
        "    \"name\": \"Ada Lovelace\",\n" +
        "    \"email\": \"ada@example.com\",\n" +
        "    \"url\": \"https://acme.example\"\n" +
        "  },\n" +
        "  \"license\": \"UNLICENSED\",\n" +
        "  \"scripts\": {\n" +
        "    \"build\": \"the-seed resource-pak build\"\n" +
        "  },\n" +
        "  \"resources\": []\n" +
        "}\n");
    });

    it("leaves out an empty email and an empty web address", () => {
      writeConfig({ "@bare": { name: "Bare Author", email: "", url: "" } });

      const description = readDescription(create("@bare", "pak"));

      expect(description.author).toEqual({ name: "Bare Author" });
    });

    it("creates nothing but the project: no other entry in the parent, nothing under the prefix, no ~/.npm", () => {
      const before = snapshotTree(tempDir).filter((entry) => !entry.path.startsWith("work"));

      createPak("my-pak");

      expect(fs.readdirSync(parentDir)).toEqual(["my-pak"]);
      expect(fs.readdirSync(path.join(parentDir, "my-pak"))).toEqual(["package.json"]);
      expect(fs.existsSync(path.join(tempDir, "projects"))).toBe(false);
      expect(fs.existsSync(path.join(scratchHome, ".npm"))).toBe(false);
      expect(snapshotTree(tempDir).filter((entry) => !entry.path.startsWith("work"))).toEqual(before);
    });

    it("sets neither the project directory nor the description on the object", () => {
      createPak("my-pak");

      expect(rp.packageDir).toBe("");
      expect(rp.package).toBeUndefined();
    });

    it("refuses an existing target with target-exists and leaves its contents unchanged", () => {
      const target = path.join(parentDir, "again-pak");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "keep.txt"), "kept");
      const before = snapshotTree(tempDir);

      const error = refusal(() => createPak("again-pak"));

      expect(error.code).toBe("target-exists");
      expect(error.message).toBe(`${target} already exists; nothing was created.`);
      expect(snapshotTree(tempDir)).toEqual(before);
      expect(fs.readFileSync(path.join(target, "keep.txt")).toString()).toBe("kept");
    });

    it("refuses an existing file of that name with target-exists", () => {
      fs.writeFileSync(path.join(parentDir, "file-pak"), "mine");

      expect(refusal(() => createPak("file-pak")).code).toBe("target-exists");
      expect(fs.readFileSync(path.join(parentDir, "file-pak")).toString()).toBe("mine");
    });

    it("refuses an author without a name with author-name-missing and the scopes edit hint, creating nothing", () => {
      writeConfig({ "@anon": { name: "", email: "x@example.com", url: "" } });
      const before = snapshotTree(tempDir);

      const error = refusal(() => create("@anon", "pak"));

      expect(error.code).toBe("author-name-missing");
      expect(error.message).toBe("Required author name is missing for scope '@anon'.");
      expect(error.hint).toBe("Set the author's name with \"the-seed scopes edit\" (scope @anon).");
      expect(snapshotTree(tempDir)).toEqual(before);
    });

    it("refuses a scope that is not configured, creating nothing", () => {
      const before = snapshotTree(tempDir);

      const error = refusal(() => create("@nope", "pak"));

      expect(error.code).toBe("unknown-scope");
      expect(snapshotTree(tempDir)).toEqual(before);
    });

    it.each(["3d", "Hello", "", "a b", "päk"])("refuses the name %j with invalid-name, creating nothing", (name) => {
      const before = snapshotTree(tempDir);

      const error = refusal(() => createPak(name));

      expect(error.code).toBe("invalid-name");
      expect(snapshotTree(tempDir)).toEqual(before);
    });

    it.each(["class", "ecs", "a--b", "mesh.loader", "x1"])("accepts the name %j (the resource pak form has no identifier rules)", (name) => {
      const result = createPak(name);

      expect(result).toBe(path.join(parentDir, name));
      expect(readDescription(result).name).toBe(`@test/${name}`);
    });

    it("checks the name before the scope", () => {
      expect(refusal(() => create("@nope", "3d")).code).toBe("invalid-name");
    });
  });

  it("should add a resource using process.cwd() by default", () => {
    const pakDir = createPak("my-pak");

    // Create a dummy resource file in the pak directory
    const fileName = "testFile.txt";
    const filePath = path.join(pakDir, fileName);
    fs.writeFileSync(filePath, "Dummy content");

    // Use the packageDir parameter (since process.cwd() won't match pakDir in tests)
    rp.addResource("testResource", fileName, pakDir);

    expect(rp.package?.resources).toContainEqual(expect.objectContaining({
      name: "testResource",
      filename: fileName,
    }));
    expect(rp.package?.resources?.length).toBe(1);
  });

  it("should add a resource with explicit packageDir parameter", () => {
    const pakDir = createPak("my-pak");

    const fileName = "asset.png";
    const filePath = path.join(pakDir, fileName);
    fs.writeFileSync(filePath, "PNG data");

    rp.addResource("myAsset", fileName, pakDir);

    const savedPkg = JSON.parse(fs.readFileSync(path.join(pakDir, "package.json")).toString());
    expect(savedPkg.resources).toHaveLength(1);
    expect(savedPkg.resources[0].name).toBe("myAsset");
    expect(savedPkg.resources[0].filename).toBe(fileName);
    expect(savedPkg.resources[0].size).toBeGreaterThan(0);
  });

  it("should not add a duplicate resource name", () => {
    const pakDir = createPak("my-pak");

    const file1 = path.join(pakDir, "file1.txt");
    const file2 = path.join(pakDir, "file2.txt");
    fs.writeFileSync(file1, "content1");
    fs.writeFileSync(file2, "content2");

    rp.addResource("dup", "file1.txt", pakDir);
    rp.addResource("dup", "file2.txt", pakDir);

    const savedPkg = JSON.parse(fs.readFileSync(path.join(pakDir, "package.json")).toString());
    expect(savedPkg.resources).toHaveLength(1);
    expect(savedPkg.resources[0].filename).toBe("file1.txt");
  });

  it("should keep the project description after a resource is added", () => {
    const pakDir = createPak("my-pak");
    fs.writeFileSync(path.join(pakDir, "a.txt"), "a");
    rp.addResource("a", "a.txt", pakDir);

    const packageJsonPath = path.join(pakDir, "package.json");
    expect(fs.existsSync(packageJsonPath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(packageJsonPath).toString());
    expect(saved.name).toBe("@test/my-pak");
  });

  it("should build a .pak file with explicit packageDir", () => {
    const pakDir = createPak("my-pak");

    // Add two resources
    const file1 = path.join(pakDir, "res1.txt");
    const file2 = path.join(pakDir, "res2.dat");
    fs.writeFileSync(file1, "Hello resource 1");
    fs.writeFileSync(file2, "Resource 2 data");

    rp.addResource("resource1", "res1.txt", pakDir);
    rp.addResource("resource2", "res2.dat", pakDir);

    // Build with explicit packageDir
    rp.build(pakDir);

    const pakFile = path.join(pakDir, "my-pak.pak");
    expect(fs.existsSync(pakFile)).toBe(true);

    // Verify the .pak starts with a JSON header holding a 10-digit header size
    const content = fs.readFileSync(pakFile).toString();
    const header = JSON.parse(content.substring(0, content.indexOf("\n")));
    expect(header.headerSize).toMatch(/^\d{10}$/);
  });

  it("should build using packageDir parameter instead of cwd", () => {
    const pakDir = createPak("build-test");

    const file = path.join(pakDir, "data.bin");
    fs.writeFileSync(file, "binary data");
    rp.addResource("data", "data.bin", pakDir);

    // Build with explicit pakDir (not relying on process.cwd())
    rp.build(pakDir);

    const pakFile = path.join(pakDir, "build-test.pak");
    expect(fs.existsSync(pakFile)).toBe(true);

    // Read the pak and verify it contains header JSON + resource data
    const pakContent = fs.readFileSync(pakFile);
    expect(pakContent.length).toBeGreaterThan(11); // header size + newline + content
  });

  describe("readProject", () => {
    type ReadProject = (dir: string) => unknown;
    const read = (dir: string): unknown => (rp as unknown as { readProject: ReadProject }).readProject(dir);

    const projectWith = (content: string | null): string => {
      const dir = path.join(parentDir, "proj");
      fs.mkdirSync(dir);
      if (content !== null) fs.writeFileSync(path.join(dir, "package.json"), content);
      return dir;
    };

    const expectRefused = (dir: string, rule: string | RegExp): ProjectErrorShape => {
      const error = refusal(() => read(dir));
      expect(error.code).toBe("not-pak-project");
      expect(error.hint).toBe(createPakHint());
      expect(error.message.startsWith(`${dir} is not a resource pak project: `)).toBe(true);
      if (typeof rule === "string") {
        expect(error.message).toBe(`${dir} is not a resource pak project: ${rule}.`);
      } else {
        expect(error.message).toMatch(rule);
      }
      return error;
    };

    it("returns the parsed description of a pak project", () => {
      const dir = createPak("ok-pak");

      const project = read(dir) as { name: string; resources: unknown[] };

      expect(project.name).toBe("@test/ok-pak");
      expect(project.resources).toEqual([]);
    });

    it("refuses a directory without package.json", () => {
      expectRefused(projectWith(null), "no package.json");
    });

    it("refuses a package.json that cannot be read", () => {
      const dir = projectWith(null);
      fs.mkdirSync(path.join(dir, "package.json"));

      expectRefused(dir, /package\.json/);
    });

    it("refuses a package.json that is not JSON, giving the first line of the parser's message", () => {
      const dir = projectWith("{ not json\n");
      let parserMessage = "";
      try {
        JSON.parse("{ not json\n");
      } catch (error) {
        parserMessage = (error as Error).message.split("\n")[0];
      }

      expectRefused(dir, `package.json is not valid JSON (${parserMessage})`);
    });

    it.each(["[]", "42", "\"text\"", "null"])("refuses a package.json that is not an object (%s)", (content) => {
      expectRefused(projectWith(content), /package\.json/);
    });

    it.each([
      ["no name", { resources: [] }],
      ["a name that is not text", { name: 5, resources: [] }],
      ["no scope", { name: "plain", resources: [] }],
      ["an empty scope", { name: "@/pak", resources: [] }],
      ["an empty name", { name: "@scope/", resources: [] }],
      ["no @", { name: "scope/pak", resources: [] }],
      ["two slashes", { name: "@scope/a/b", resources: [] }],
    ])("refuses %s: \"name\" is not of the form @scope/name", (_label, description) => {
      expectRefused(projectWith(JSON.stringify(description)), "\"name\" is not of the form @scope/name");
    });

    it("refuses a description without resources", () => {
      expectRefused(projectWith(JSON.stringify({ name: "@t/pak" })), "package.json has no \"resources\" list");
    });

    it.each([["an object", {}], ["text", "a"], ["a number", 3]])("refuses resources that are %s", (_label, value) => {
      expectRefused(projectWith(JSON.stringify({ name: "@t/pak", resources: value })), /"resources"/);
    });

    it.each([
      ["no name", { filename: "a.txt", size: 1 }, /name/],
      ["a name that is not text", { name: 1, filename: "a.txt", size: 1 }, /name/],
      ["no filename", { name: "a", size: 1 }, /filename/],
      ["a filename that is not text", { name: "a", filename: 7, size: 1 }, /filename/],
      ["not an object", "a.txt", /resources/],
    ])("refuses an entry with %s", (_label, entry, field) => {
      expectRefused(projectWith(JSON.stringify({ name: "@t/pak", resources: [entry] })), field);
    });

    it.each([
      ["a list", ["a"]],
      ["text", "a"],
      ["an object with a number", { type: 3 }],
      ["an object with a nested object", { type: { a: "b" } }],
    ])("refuses attributes that are %s rather than an object of strings", (_label, attributes) => {
      const description = { name: "@t/pak", resources: [{ name: "a", filename: "a.txt", size: 1, attributes }] };

      expectRefused(projectWith(JSON.stringify(description)), /attributes/);
    });

    it("accepts attributes that are an object of strings, empty values included", () => {
      const description = { name: "@t/pak", resources: [{ name: "a", filename: "a.txt", size: 1, attributes: { type: "", loop: "true" } }] };

      expect(() => read(projectWith(JSON.stringify(description)))).not.toThrow();
    });

    it("maps not-pak-project to status 2", () => {
      expect(projectErrorStatus("not-pak-project")).toBe(2);
    });
  });

  describe("build", () => {
    type Build = (dir: string) => string;
    type Spied = Record<"openSync" | "readSync", (...args: unknown[]) => unknown>;
    const build = (dir: string): string => (rp.build as unknown as Build)(dir);
    const pakPath = (dir: string, name = "my-pak"): string => path.join(dir, name + ".pak");
    const tmpFiles = (dir: string): string[] => fs.readdirSync(dir).filter((entry) => entry.endsWith(".tmp"));
    const modules = (): Spied[] => [fs as unknown as Spied, fsExtra as unknown as Spied];

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /** A project with the given files, each added as a resource named after its file. */
    const pakWith = (files: Record<string, string | Buffer>, name = "my-pak"): string => {
      const dir = createPak(name);
      for (const file of Object.keys(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), files[file]);
        rp.addResource(file, file, dir);
      }
      return dir;
    };

    /** Rewrites the project description by hand, for what `add` would not let through. */
    const rewrite = (dir: string, change: (description: Record<string, unknown>) => void): void => {
      const description = readDescription(dir) as Record<string, unknown>;
      change(description);
      fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(description, null, 2) + "\n");
    };

    it("returns the path of the pak it wrote", () => {
      const dir = pakWith({ "a.txt": "abc" });

      expect(build(dir)).toBe(pakPath(dir));
      expect(fs.existsSync(pakPath(dir))).toBe(true);
    });

    it("uses the files' sizes at build time, not the ones recorded by add", () => {
      const dir = pakWith({ "a.txt": "abc" });
      fs.writeFileSync(path.join(dir, "a.txt"), "a much longer content than before");

      build(dir);

      const pak = fs.readFileSync(pakPath(dir));
      const line = JSON.parse(pak.subarray(0, pak.indexOf(0x0a)).toString("utf8"));
      expect(line.resources[0].size).toBe("a much longer content than before".length);
      expect(pak.subarray(pak.indexOf(0x0a) + 1).toString()).toBe("a much longer content than before");
    });

    it("leaves package.json byte-identical, a stale recorded size included", () => {
      const dir = pakWith({ "a.txt": "abc" });
      fs.writeFileSync(path.join(dir, "a.txt"), "changed");
      const before = fileDigest(path.join(dir, "package.json"));
      const mtime = fs.statSync(path.join(dir, "package.json")).mtimeMs;

      build(dir);

      expect(fileDigest(path.join(dir, "package.json"))).toBe(before);
      expect(fs.statSync(path.join(dir, "package.json")).mtimeMs).toBe(mtime);
    });

    it("states the description line's UTF-8 byte length as headerSize", () => {
      const dir = createPak("unicode-pak");
      fs.writeFileSync(path.join(dir, "a.txt"), "abc");
      rewrite(dir, (description) => {
        description.name = "@test/päk";
        description.resources = [{ name: "música", filename: "a.txt", size: 3, attributes: { "日本": "😀" } }];
      });

      build(dir);

      const pak = fs.readFileSync(path.join(dir, "päk.pak"));
      const lineBytes = pak.subarray(0, pak.indexOf(0x0a) + 1);
      expect(Number(JSON.parse(lineBytes.toString("utf8")).headerSize)).toBe(lineBytes.length);
      expect(pak.subarray(lineBytes.length).toString()).toBe("abc");
    });

    it("builds a resource that is an empty file (guard)", () => {
      const dir = pakWith({ "empty.dat": "", "b.txt": "bb" });

      build(dir);

      const pak = fs.readFileSync(pakPath(dir));
      const line = JSON.parse(pak.subarray(0, pak.indexOf(0x0a)).toString("utf8"));
      expect(line.resources.map((r: { size: number }) => r.size)).toEqual([0, 2]);
      expect(pak.subarray(pak.indexOf(0x0a) + 1).toString()).toBe("bb");
    });

    it("builds a project with no resources as a pak with an empty list (guard)", () => {
      const dir = createPak("my-pak");

      build(dir);

      const pak = fs.readFileSync(pakPath(dir)).toString();
      expect(pak.indexOf("\n")).toBe(pak.length - 1);
      expect(JSON.parse(pak).resources).toEqual([]);
    });

    it("replaces an earlier pak and leaves no temporary file", () => {
      const dir = pakWith({ "a.txt": "abc" });
      build(dir);
      fs.writeFileSync(path.join(dir, "a.txt"), "second");

      build(dir);

      expect(fs.readFileSync(pakPath(dir)).toString().endsWith("second")).toBe(true);
      expect(tmpFiles(dir)).toEqual([]);
      expect(fs.readdirSync(dir).sort()).toEqual(["a.txt", "my-pak.pak", "package.json"]);
    });

    describe("refusals leave an existing pak byte-identical and no temporary file", () => {
      /** A project with a built pak of one resource "theme" (music/theme.ogg), ready to be broken. */
      const builtPak = (): string => {
        const dir = createPak("my-pak");
        fs.mkdirSync(path.join(dir, "music"));
        fs.writeFileSync(path.join(dir, "music", "theme.ogg"), "ogg data");
        rp.addResource("theme", "music/theme.ogg", dir);
        build(dir);
        return dir;
      };

      /** Builds again, expecting a refusal with the given status (and code or message when given), and checks nothing changed. */
      const expectRefusal = (dir: string, status: number, expected: { code?: string; message?: string | RegExp } = {}): ProjectErrorShape => {
        const before = fileDigest(pakPath(dir));
        const error = refusal(() => build(dir));

        expect(projectErrorStatus(error.code as ProjectErrorCode)).toBe(status);
        if (expected.code !== undefined) expect(error.code).toBe(expected.code);
        if (typeof expected.message === "string") expect(error.message).toBe(expected.message);
        if (expected.message instanceof RegExp) expect(error.message).toMatch(expected.message);
        expect(fileDigest(pakPath(dir))).toBe(before);
        expect(tmpFiles(dir)).toEqual([]);
        return error;
      };

      it("a resource file that is missing", () => {
        const dir = builtPak();
        fs.rmSync(path.join(dir, "music", "theme.ogg"));

        expectRefusal(dir, 2, { code: "resource-file-missing", message: "Resource \"theme\" refers to music/theme.ogg, which is missing." });
      });

      it("a resource file that is a directory", () => {
        const dir = builtPak();
        fs.rmSync(path.join(dir, "music", "theme.ogg"));
        fs.mkdirSync(path.join(dir, "music", "theme.ogg"));

        expectRefusal(dir, 2, { code: "resource-file-missing", message: "Resource \"theme\" refers to music/theme.ogg, which is not a file." });
      });

      it("a resource file outside the project", () => {
        const dir = builtPak();
        fs.writeFileSync(path.join(parentDir, "outside.dat"), "outside");
        rewrite(dir, (description) => {
          (description.resources as Array<{ filename: string }>)[0].filename = "../outside.dat";
        });

        expectRefusal(dir, 2, { code: "resource-file-missing", message: "Resource \"theme\" refers to ../outside.dat, which is outside the project." });
      });

      it("a resource name with an unpaired surrogate", () => {
        const dir = builtPak();
        rewrite(dir, (description) => {
          (description.resources as Array<{ name: string }>)[0].name = "bad\ud800name";
        });

        expectRefusal(dir, 2, { message: /^Resource \d+ has a name that is not valid Unicode text\.$/ });
      });

      it("two entries with one name", () => {
        const dir = builtPak();
        fs.writeFileSync(path.join(dir, "other.ogg"), "other");
        rewrite(dir, (description) => {
          (description.resources as unknown[]).push({ name: "theme", filename: "other.ogg", size: 5 });
        });

        expectRefusal(dir, 2, { message: "Resource \"theme\" appears more than once in package.json." });
      });

      it("a resource replaced by a directory between the check and the copy is write-failed", () => {
        const dir = builtPak();
        const target = path.join(dir, "music", "theme.ogg");
        let swapped = false;
        for (const module of modules()) {
          const original = module.openSync;
          jest.spyOn(module, "openSync").mockImplementation((...args: unknown[]) => {
            if (!swapped && typeof args[0] === "string" && path.resolve(args[0]) === target) {
              swapped = true;
              fs.rmSync(target);
              fs.mkdirSync(target);
            }
            return original.apply(module, args);
          });
        }

        const error = expectRefusal(dir, 1, { code: "write-failed" });

        expect(swapped).toBe(true);
        expect(error.message).toContain(pakPath(dir));
      });

      it("a read-only project directory is write-failed", () => {
        if (process.getuid && process.getuid() === 0) return;
        const dir = builtPak();
        fs.chmodSync(dir, 0o555);
        try {
          const error = expectRefusal(dir, 1, { code: "write-failed" });

          expect(error.message).toMatch(/^Cannot write .+: .+/);
        } finally {
          fs.chmodSync(dir, 0o755);
        }
      });

      it("a file whose bytes differ in number from the size taken at the start is resource-changed, status 1", () => {
        const dir = builtPak();
        const target = path.join(dir, "music", "theme.ogg");
        let shortened = false;
        const resourceDescriptors = new Set<number>();
        for (const module of modules()) {
          const originalOpen = module.openSync;
          jest.spyOn(module, "openSync").mockImplementation((...args: unknown[]) => {
            const descriptor = originalOpen.apply(module, args) as number;
            if (typeof args[0] === "string" && path.resolve(args[0]) === target) resourceDescriptors.add(descriptor);
            return descriptor;
          });
          const original = module.readSync;
          jest.spyOn(module, "readSync").mockImplementation((...args: unknown[]) => {
            const count = original.apply(module, args) as number;
            if (!shortened && count > 0 && resourceDescriptors.has(args[0] as number)) {
              shortened = true;
              return count - 1;
            }
            return count;
          });
        }

        expectRefusal(dir, 1, { code: "resource-changed", message: "music/theme.ogg changed while the pak was written; build again." });

        expect(shortened).toBe(true);
      });
    });
  });
});
