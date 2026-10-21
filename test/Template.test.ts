/*
 * Tests for creating code projects from the templates.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - `Template.createPackage(scope, name, parentDir?, now?)` returns the absolute path of the new
 *   project; `Template.type` is set to the kind beforehand, as the command line does. The tests
 *   reach it through a cast so that this file still compiles while the signature is the old one.
 * - A refusal is an `Error` whose `name` is "ProjectError" and which carries `code` and `hint`;
 *   it is recognised by name so that no static import of the class is needed.
 * - The message for an email or web address with an unusable character names the detail ("email"
 *   or "web address"/"URL") and the character in double quotes; for a control character only the
 *   detail is checked.
 * - The creation message printed by the command is `Created <kind> <scope>/<name> in ./<name>`.
 */
import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Template from "../src/Template";
import { runTheSeed, snapshotTree } from "./helpers/RunCli";

interface ProjectErrorShape extends Error {
  code: string;
  hint?: string;
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "template-test-"));
}

describe("test Template", () => {
  let configDir: string;
  let config: Config;
  let template: Template;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);

    // Create a scope for testing
    const scopes = config.config.scopes;
    scopes["@test-scope"] = {
      author: {
        name: "Test Author",
        email: "test@example.com",
        url: "https://example.com"
      }
    };
    config.saveConfig();
  });

  beforeEach(() => {
    template = new Template(config);
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });

  describe("askName", () => {
    it("returns questions with scope list and name input", () => {
      template.type = "component";
      const questions = template.askName();

      expect(questions).toHaveLength(2);
      expect(questions[0].type).toBe("list");
      expect(questions[0].name).toBe("scopeName");
      expect(questions[0].choices).toContain("@test-scope");
      expect(questions[1].name).toBe("templateName");
    });
  });

});

const kinds = ["component", "system", "program"] as const;
type Kind = typeof kinds[number];

const kindTitle: Record<Kind, string> = {
  component: "a component for libecs-cpp",
  system: "a system for libecs-cpp",
  program: "a program for The Seed"
};

interface Author {
  name: string;
  email: string;
  url: string;
}

const ada: Author = { name: "Ada Lovelace", email: "ada@example.com", url: "https://acme.example" };

type CreatePackage = (scope: string, name: string, parentDir?: string, now?: Date) => string;

/** Writes a configuration with the given scopes into a fresh configuration directory under root. */
function writeConfig(root: string, scopes: Record<string, Author>): { configDir: string; prefix: string } {
  const configDir = path.join(root, "the-seed");
  const prefix = path.join(root, "prefix");
  fs.mkdirSync(configDir, { recursive: true });
  const body: Record<string, { author: Author }> = {};
  for (const scope of Object.keys(scopes)) {
    body[scope] = { author: scopes[scope] };
  }
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix, scopes: body }));
  return { configDir, prefix };
}

/** Every file under dir (relative paths with "/" separators, dot files included), sorted. */
function listFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return found.sort();
}

function lines(file: string): string[] {
  return fs.readFileSync(file, "utf8").split("\n");
}

function expectedPackageJson(kind: Kind, name: string, author: Author): string {
  const authorObject: Record<string, string> = { name: author.name };
  if (author.email !== "") authorObject.email = author.email;
  if (author.url !== "") authorObject.url = author.url;
  return JSON.stringify({
    name: "@acme/" + name,
    version: "0.0.1",
    description: name + ", " + kindTitle[kind],
    author: authorObject,
    license: "MIT",
    scripts: {
      "build": "the-seed build native",
      "build-win64": "the-seed build windows"
    }
  }, null, 2) + "\n";
}

describe("createPackage", () => {
  let root: string;
  let parentDir: string;
  let prefix: string;
  let configDir: string;
  let savedCwd: string;
  const now = new Date(2026, 5, 1);

  const make = (scopes: Record<string, Author>, kind: Kind): Template => {
    ({ configDir, prefix } = writeConfig(root, scopes));
    const template = new Template(new Config(configDir));
    template.type = kind;
    return template;
  };

  const create = (template: Template, scope: string, name: string, date: Date = now): string =>
    (template.createPackage as unknown as CreatePackage)(scope, name, parentDir, date);

  beforeEach(() => {
    root = createTempDir();
    fs.mkdirSync(path.join(root, "cwd"));
    parentDir = path.join(root, "work");
    fs.mkdirSync(parentDir);
    // The tool's own working directory is a scratch one, so that no case can write into the checkout.
    savedCwd = process.cwd();
    process.chdir(path.join(root, "cwd"));
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Runs create and returns the error it throws, failing the case when it throws no ProjectError. */
  const refusal = (template: Template, scope: string, name: string): ProjectErrorShape => {
    let caught: unknown;
    try {
      create(template, scope, name);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error) || caught.name !== "ProjectError") {
      throw new Error("expected a ProjectError but got " + String(caught));
    }
    return caught as ProjectErrorShape;
  };

  for (const kind of kinds) {
    describe(kind, () => {
      const name = "mesh.loader";

      it("writes the author's details where each belongs and returns the project path", () => {
        const template = make({ "@acme": ada }, kind);

        const project = create(template, "@acme", name);

        expect(project).toBe(path.join(parentDir, name));
        expect(path.isAbsolute(project)).toBe(true);
        expect(lines(path.join(project, "COPYING"))[2]).toBe("Copyright (c) 2026 Ada Lovelace");
        expect(fs.readFileSync(path.join(project, "AUTHORS"), "utf8")).toBe("Ada Lovelace <ada@example.com>\n");
        expect(fs.readFileSync(path.join(project, "configure.ac"), "utf8")).toContain(
          `AC_INIT([${name}], [0.0.1], [ada@example.com], [${name}], [https://acme.example])`);
        expect(fs.readFileSync(path.join(project, "package.json"), "utf8")).toBe(expectedPackageJson(kind, name, ada));
        if (kind !== "program") {
          expect(fs.readFileSync(path.join(project, "src", name + ".cpp"), "utf8")).toContain("\"@acme/" + name + "\"");
          const pc = lines(path.join(project, name + ".pc.in"));
          expect(pc).toContain(`Description: ${name}, ${kindTitle[kind]}`);
          expect(pc).toContain("URL: https://acme.example");
        } else {
          expect(fs.existsSync(path.join(project, name + ".pc.in"))).toBe(false);
        }
      });

      it("leaves no template variable in any file name or content", () => {
        const template = make({ "@acme": ada }, kind);

        const project = create(template, "@acme", name);

        for (const file of listFiles(project)) {
          const content = fs.readFileSync(path.join(project, file), "utf8");
          for (const word of ["{{", "}}", "SKELETON", "AUTHOR_", "SCOPE"]) {
            expect({ file, inName: file.includes(word), inContent: content.includes(word), word })
              .toEqual({ file, inName: false, inContent: false, word });
          }
        }
      });

      it("writes nothing for a missing email and web address: no <>, no URL line, no empty JSON fields", () => {
        const bare: Author = { name: "Ada Lovelace", email: "", url: "" };
        const template = make({ "@acme": bare }, kind);

        const project = create(template, "@acme", name);

        expect(fs.readFileSync(path.join(project, "AUTHORS"), "utf8")).toBe("Ada Lovelace\n");
        expect(fs.readFileSync(path.join(project, "configure.ac"), "utf8")).toContain(
          `AC_INIT([${name}], [0.0.1], [], [${name}], [])`);
        expect(fs.readFileSync(path.join(project, "package.json"), "utf8")).toBe(expectedPackageJson(kind, name, bare));
        const author = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")).author;
        expect(Object.keys(author)).toEqual(["name"]);
        if (kind !== "program") {
          const pc = lines(path.join(project, name + ".pc.in"));
          expect(pc.filter((line) => line.startsWith("URL:"))).toEqual([]);
          expect(pc.filter((line) => line.startsWith("Description:"))).toEqual([`Description: ${name}, ${kindTitle[kind]}`]);
        }
        for (const file of listFiles(project)) {
          expect(fs.readFileSync(path.join(project, file), "utf8")).not.toContain("<>");
        }
      });

      it("writes an author name with special characters as given and as valid JSON", () => {
        const special = "Zoë \"Q\" O'Brien, [Lab] & <Co>";
        const template = make({ "@acme": { name: special, email: ada.email, url: ada.url } }, kind);

        const project = create(template, "@acme", name);

        expect(lines(path.join(project, "COPYING"))[2]).toBe("Copyright (c) 2026 " + special);
        expect(fs.readFileSync(path.join(project, "AUTHORS"), "utf8")).toBe(special + " <ada@example.com>\n");
        expect(JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")).author.name).toBe(special);
      });

      it("writes a '#' in the web address as \\# in the pkg-config file and as given elsewhere", () => {
        const url = "https://acme.example/#top";
        const template = make({ "@acme": { name: ada.name, email: ada.email, url } }, kind);

        const project = create(template, "@acme", name);

        expect(fs.readFileSync(path.join(project, "configure.ac"), "utf8")).toContain(`[${name}], [${url}])`);
        expect(JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8")).author.url).toBe(url);
        if (kind !== "program") {
          expect(lines(path.join(project, name + ".pc.in"))).toContain("URL: https://acme.example/\\#top");
        }
      });

      it("takes the year from the date it is given", () => {
        const template = make({ "@acme": ada }, kind);

        const project = create(template, "@acme", name, new Date(2031, 0, 2));

        expect(lines(path.join(project, "COPYING"))[2]).toBe("Copyright (c) 2031 Ada Lovelace");
      });

      it("creates nothing under the prefix and nothing but the project in the parent directory", () => {
        const template = make({ "@acme": ada }, kind);

        create(template, "@acme", name);

        expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
        expect(fs.readdirSync(parentDir)).toEqual([name]);
      });
    });
  }

  describe("refusals", () => {
    const hint = "Set the author's name with \"the-seed scopes edit\" (scope @acme).";
    // Everything under the scratch root: the parent directory (hidden entries included) and the rest.
    const state = (): unknown => snapshotTree(root);

    it("an author without a name is refused with the scopes edit hint and nothing created", () => {
      const template = make({ "@acme": { name: "", email: ada.email, url: ada.url } }, "component");
      const snapshot = state();

      const error = refusal(template, "@acme", "hello");

      expect(error.code).toBe("author-name-missing");
      expect(error.message).toBe("Required author name is missing for scope '@acme'.");
      expect(error.hint).toBe(hint);
      expect(state()).toEqual(snapshot);
      expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
    });

    const characters: Array<[string, string]> = [
      ["[", "["], ["]", "]"], ["$", "$"], ["'", "'"], ["\"", "\""], ["\\", "\\"], ["`", "`"], ["a control character", "\u0007"]
    ];
    for (const detail of ["email", "url"] as const) {
      for (const [label, character] of characters) {
        it(`${detail} containing ${label} is refused naming the detail and the character`, () => {
          const author = { ...ada };
          author[detail] = detail === "email" ? `a${character}b@example.com` : `https://acme.example/a${character}b`;
          const template = make({ "@acme": author }, "system");
          const snapshot = state();

          const error = refusal(template, "@acme", "hello");

          expect(error.code).toBe("author-detail-unusable");
          expect(error.message).toContain("@acme");
          expect(error.message).toMatch(detail === "email" ? /email/ : /web address|URL/i);
          if (label !== "a control character") {
            expect(error.message).toContain(`"${character}"`);
          }
          expect(error.hint).toBe(hint);
          expect(state()).toEqual(snapshot);
        });
      }
    }

    it("an email with ' has the documented message", () => {
      const template = make({ "@acme": { ...ada, email: "o'brien@example.com" } }, "component");

      const error = refusal(template, "@acme", "hello");

      expect(error.message).toBe("The author's email for scope @acme contains \"'\", which the build configuration cannot hold.");
    });

    it("an unconfigured scope is refused with unknown-scope and nothing created", () => {
      const template = make({ "@acme": ada }, "component");
      const snapshot = state();

      const error = refusal(template, "@nope", "hello");

      expect(error.code).toBe("unknown-scope");
      expect(state()).toEqual(snapshot);
    });

    it("an existing directory holding a user file is refused and left as it was", () => {
      const template = make({ "@acme": ada }, "component");
      const target = path.join(parentDir, "hello");
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "mine.txt"), "keep me\n");
      const snapshot = state();

      const error = refusal(template, "@acme", "hello");

      expect(error.code).toBe("target-exists");
      expect(error.message).toBe(`${target} already exists; nothing was created.`);
      expect(state()).toEqual(snapshot);
      expect(fs.readFileSync(path.join(target, "mine.txt"), "utf8")).toBe("keep me\n");
    });

    it("an existing file is refused and left as it was", () => {
      const template = make({ "@acme": ada }, "system");
      const target = path.join(parentDir, "hello");
      fs.writeFileSync(target, "keep me\n");
      const snapshot = state();

      const error = refusal(template, "@acme", "hello");

      expect(error.code).toBe("target-exists");
      expect(error.message).toBe(`${target} already exists; nothing was created.`);
      expect(state()).toEqual(snapshot);
    });

    it("an existing symbolic link is refused and left as it was", () => {
      const template = make({ "@acme": ada }, "program");
      const elsewhere = path.join(root, "elsewhere");
      fs.mkdirSync(elsewhere);
      const target = path.join(parentDir, "hello");
      fs.symlinkSync(elsewhere, target);
      const snapshot = state();

      const error = refusal(template, "@acme", "hello");

      expect(error.code).toBe("target-exists");
      expect(error.message).toBe(`${target} already exists; nothing was created.`);
      expect(state()).toEqual(snapshot);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.readdirSync(elsewhere)).toEqual([]);
    });
  });
});

// `<scope>/<name>` is read by the command-line parser, and the project is created in the current directory.
// Choices: the configuration has the scope @s (and the scopes of the case, where it needs them); the
// working directory and the home are scratch directories.
describe("template command line", () => {
  let root: string;
  let configDir: string;
  let prefix: string;
  let cwd: string;

  const configure = (scopes: Record<string, Author>): void => {
    ({ configDir, prefix } = writeConfig(root, scopes));
  };

  beforeEach(() => {
    root = createTempDir();
    cwd = path.join(root, "work");
    fs.mkdirSync(cwd);
    configure({ "@s": { name: "S Author", email: "s@example.com", url: "https://example.com" } });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const run = (args: string[]) => runTheSeed(args, { home: root, configDir, cwd, interactive: false });
  const packageNameIn = (dir: string): string => JSON.parse(fs.readFileSync(path.join(dir, "package.json")).toString()).name;

  it("component @s/hello creates ./hello in the working directory for the scope @s", async () => {
    const result = await run(["template", "component", "@s/hello"]);

    expect(result.status).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(fs.existsSync(path.join(cwd, "hello", "src", "hello.hpp"))).toBe(true);
    expect(packageNameIn(path.join(cwd, "hello"))).toBe("@s/hello");
  });

  it("component s/hello (without the @) is the scope @s", async () => {
    const result = await run(["template", "component", "s/hello"]);

    expect(result.status).toBe(0);
    expect(packageNameIn(path.join(cwd, "hello"))).toBe("@s/hello");
  });

  for (const kind of ["system", "program"]) {
    it(`${kind} @s/hello creates ./hello in the working directory`, async () => {
      const result = await run(["template", kind, "@s/hello"]);

      expect(result.status).toBe(0);
      expect(fs.existsSync(path.join(cwd, "hello", "src", "hello.cpp"))).toBe(true);
    });
  }

  for (const kind of kinds) {
    it(`${kind} @s/hello prints one Created line and nothing else`, async () => {
      const result = await run(["template", kind, "@s/hello"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`Created ${kind} @s/hello in ./hello\n`);
      expect(result.stderr).toBe("");
      expect(fs.readdirSync(cwd)).toEqual(["hello"]);
      expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
    });
  }

  it("an author without a name is status 2 with the scopes edit hint, no Unexpected error and nothing created", async () => {
    configure({ "@anon": { name: "", email: "x@example.com", url: "" } });
    const before = snapshotTree(root);

    const result = await run(["template", "component", "@anon/hello"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Error: Required author name is missing for scope '@anon'.\n" +
      "Set the author's name with \"the-seed scopes edit\" (scope @anon).\n");
    expect(result.stderr).not.toContain("Unexpected error");
    expect(snapshotTree(root)).toEqual(before);
  });

  it("an existing ./hello is status 1 with the path in the message and its contents unchanged", async () => {
    fs.mkdirSync(path.join(cwd, "hello"));
    fs.writeFileSync(path.join(cwd, "hello", "mine.txt"), "keep me\n");
    const before = snapshotTree(root);

    const result = await run(["template", "component", "@s/hello"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Error: ${path.join(cwd, "hello")} already exists; nothing was created.`);
    expect(result.stderr.match(/^Error:/gm)).toHaveLength(1);
    expect(result.stderr).not.toContain("Unexpected error");
    expect(snapshotTree(root)).toEqual(before);
  });

  it("an email with ' is status 2 naming the detail and the character, and nothing is created", async () => {
    configure({ "@q": { name: "Q Author", email: "o'brien@example.com", url: "" } });
    const before = snapshotTree(root);

    const result = await run(["template", "system", "@q/hello"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error: The author's email for scope @q contains \"'\", which the build configuration cannot hold.");
    expect(result.stderr).not.toContain("Unexpected error");
    expect(snapshotTree(root)).toEqual(before);
  });

  for (const form of ["@s/", "@s", "@s/a/b", "@s/a b"]) {
    it(`component ${JSON.stringify(form)} is a usage error with the form message and nothing created`, async () => {
      const before = snapshotTree(root);

      const result = await run(["template", "component", form]);

      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`Invalid value "${form}" for <scope>/<name>; expected a scope and a name such as @my-scope/hello.`);
      expect(result.prompts).toEqual([]);
      expect(snapshotTree(root)).toEqual(before);
    });
  }

  it("component @nope/x with a scope that is not configured is refused before anything is written", async () => {
    const before = snapshotTree(root);

    const result = await run(["template", "component", "@nope/x"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Error: Scope \"@nope\" is not configured. Configured scopes: @s.");
    expect(result.stderr.match(/^Error:/gm)).toHaveLength(1);
    expect(result.stderr).not.toContain("Unexpected error");
    expect(result.stderr).not.toContain("Copying template");
    expect(result.prompts).toEqual([]);
    expect(snapshotTree(root)).toEqual(before);
  });
});
