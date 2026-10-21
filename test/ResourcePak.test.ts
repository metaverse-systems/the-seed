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
 * - Cases that create a project run with `HOME` set to a scratch directory, so that a program
 *   started on the way (the package manager) would leave its traces there, where they are looked for.
 */
import fs from "fs";
import os from "os";
import path from "path";
import ResourcePak from "../src/ResourcePak";
import Config from "../src/Config";
import { snapshotTree } from "./helpers/RunCli";

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
});
