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
 * - The generated-files group compares each project with the specified text for its kind; the
 *   program's `README.md` says "builds the program and installs it into the tool's prefix; `the-seed build
 *   windows` cross-compiles it for Windows." and its `configure.ac` keeps today's order and `windows.h` check.
 * - The creation message printed by the command is `Created <kind> <scope>/<name> in ./<name>`.
 * - The name question of `askName()` carries `validate(input)`, which returns `true` for a usable
 *   name and the reason (the text `validateProjectName` gives) otherwise, as inquirer expects. The
 *   mocked prompt of the command-line helper does not run validators, so the interactive case
 *   uses a prompt stand-in of its own that does what inquirer does: it runs `validate` on each
 *   answer and, when it returns text, takes the next answer for that question instead.
 * - A name refused on the command line is refused by the argument parser (status 3); the library
 *   refuses it again with a `ProjectError` of code `invalid-name`, before the scope is looked at.
 */
import fs from "fs";
import path from "path";
import os from "os";
import Config from "../src/Config";
import Template from "../src/Template";
import { validateProjectName } from "../src/ProjectName";
import inquirer from "inquirer";
import { runCli } from "../src/scripts/Cli";
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

    it("gives the name question a validate that returns the reason for a refused name and true for a usable one", () => {
      template.type = "component";
      const question = template.askName()[1] as unknown as { validate?: (input: string) => string | boolean };

      expect(typeof question.validate).toBe("function");
      const validate = question.validate as (input: string) => string | boolean;
      expect(validate("3d-mesh")).toBe(validateProjectName("3d-mesh", "component"));
      expect(validate("3d-mesh")).toContain("A project name must start with a lowercase letter");
      expect(validate("class")).toBe(
        "\"class\" cannot be used as the name of a component: its C++ name \"class\" is a reserved word.");
      expect(validate("")).toContain("A project name must start with a lowercase letter");
      expect(validate("hello-world")).toBe(true);
      expect(validate("mesh.loader")).toBe(true);
    });

    it("names the kind in the reason for each kind", () => {
      for (const kind of kinds) {
        template.type = kind;
        const question = template.askName()[1] as unknown as { validate?: (input: string) => string | boolean };
        const validate = question.validate as (input: string) => string | boolean;
        expect(validate("ecs")).toBe(
          `"ecs" cannot be used as the name of a ${kind}: the generated code already uses the name "ecs".`);
      }
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

    for (const name of ["class", "3d-mesh", "a--b", "ecs", "Hello", ""]) {
      it(`the name ${JSON.stringify(name)} is refused as invalid-name with nothing created`, () => {
        const template = make({ "@acme": ada }, "component");
        const snapshot = state();

        const error = refusal(template, "@acme", name);

        expect(error.code).toBe("invalid-name");
        expect(error.message).toBe(validateProjectName(name, "component"));
        expect(state()).toEqual(snapshot);
        expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
      });
    }

    it("the reserved word class is refused with the kind named in the reason", () => {
      const template = make({ "@acme": ada }, "system");

      const error = refusal(template, "@acme", "class");

      expect(error.message).toBe(
        "\"class\" cannot be used as the name of a system: its C++ name \"class\" is a reserved word.");
    });

    it("a refused name is reported before a scope that is not configured", () => {
      const template = make({ "@acme": ada }, "program");
      const snapshot = state();

      const error = refusal(template, "@nope", "class");

      expect(error.code).toBe("invalid-name");
      expect(state()).toEqual(snapshot);
    });
  });

  describe("a name with a dot", () => {
    const name = "mesh.loader";

    for (const kind of kinds) {
      it(`${kind} uses the file name as given and "_" in identifiers`, () => {
        const template = make({ "@acme": ada }, kind);

        const project = create(template, "@acme", name);

        const header = fs.readFileSync(path.join(project, "src", "mesh.loader.hpp"), "utf8");
        const source = fs.readFileSync(path.join(project, "src", "mesh.loader.cpp"), "utf8");
        if (kind !== "program") {
          expect(header).toContain("class mesh_loader");
          expect(header).not.toContain("class mesh.loader");
          expect(`${header}${source}`).not.toMatch(/mesh\.loader::|mesh\.loader\(/);
          expect(source).toContain("mesh_loader::mesh_loader");
        }
        const automake = fs.readFileSync(path.join(project, "src", "Makefile.am"), "utf8");
        if (kind === "program") {
          expect(automake).toContain("bin_PROGRAMS = mesh.loader");
          expect(automake).toContain("mesh_loader_SOURCES = mesh.loader.cpp");
          expect(automake).not.toMatch(/mesh\.loader_/);
        } else {
          expect(automake).toContain("lib_LTLIBRARIES = libmesh.loader.la");
          expect(automake).toContain("libmesh_loader_la_SOURCES = mesh.loader.cpp");
          expect(automake).not.toMatch(/libmesh\.loader_la_/);
        }
      });
    }

    it("a component records the type string with the name as given", () => {
      const template = make({ "@acme": ada }, "component");

      const project = create(template, "@acme", name);

      const source = fs.readFileSync(path.join(project, "src", "mesh.loader.cpp"), "utf8");
      expect(source).toContain("\"@acme/mesh.loader\"");
    });
  });
});

// The files a new project holds: the exact tree, no empty or generic files, one README, and the
// formatting rules every template file follows.
// Choices: the expected `README.md` for a program reads "builds the program and installs it into the
// tool's prefix; `the-seed build windows` cross-compiles it for Windows."; the program's `configure.ac`
// keeps its statement order and its `windows.h` check as they are today; the ignore file is compared
// with the template's own, which is stored as `gitignore` (or `.gitignore` until it is renamed).
describe("generated files", () => {
  const templatesRoot = path.resolve(__dirname, "..", "templates");
  const name = "mesh.loader";
  const variables = [
    "name", "identifier", "scope", "package", "kind", "kind_title", "author_name", "author_contact",
    "author_email", "author_url", "pc_url_line", "readme_url_line", "year", "ecs_cpp_version", "the_seed_version"
  ];
  let root: string;
  let parentDir: string;
  let savedCwd: string;

  beforeEach(() => {
    root = createTempDir();
    fs.mkdirSync(path.join(root, "cwd"));
    parentDir = path.join(root, "work");
    fs.mkdirSync(parentDir);
    savedCwd = process.cwd();
    process.chdir(path.join(root, "cwd"));
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const generate = (kind: Kind, author: Author = ada): string => {
    const { configDir } = writeConfig(root, { "@acme": author });
    const template = new Template(new Config(configDir));
    template.type = kind;
    return (template.createPackage as unknown as CreatePackage)("@acme", name, parentDir, new Date(2026, 5, 1));
  };

  const expectedTree = (kind: Kind): string[] => {
    const tree = [
      "AUTHORS", "COPYING", "Makefile.am", "README.md", "autogen.sh", "configure.ac", ".gitignore",
      "package.json", "src/Makefile.am", `src/${name}.cpp`, `src/${name}.hpp`
    ];
    if (kind !== "program") tree.push(`${name}.pc.in`);
    return tree.sort();
  };

  const expectedReadme = (kind: Kind, author: Author): string => {
    const build = kind === "program" ? "builds the program" : "builds it for Linux";
    return [
      `# ${name}`,
      "",
      `${name} is ${kindTitle[kind]}, in the scope @acme.`,
      "",
      author.email === "" ? `Author: ${author.name}` : `Author: ${author.name} <${author.email}>`,
      ...(author.url === "" ? [] : [`Web: ${author.url}`]),
      "",
      "## Building",
      "",
      "    the-seed build native",
      "",
      `${build} and installs it into the tool's prefix; \`the-seed build windows\` cross-compiles it for Windows.`,
      "Run `the-seed help build` for the options.",
      "",
      "## Licence",
      "",
      "MIT; see COPYING.",
      ""
    ].join("\n");
  };

  const expectedConfigure = (kind: Kind): string => {
    const head = [
      "AC_PREREQ([2.71])",
      `AC_INIT([${name}], [0.0.1], [ada@example.com], [${name}], [https://acme.example])`,
      "AC_CONFIG_HEADERS([config.h])",
      "AC_PROG_CXX",
      "AM_INIT_AUTOMAKE([foreign subdir-objects])",
      "LT_INIT",
      ""
    ];
    const pkg = ["PKG_PROG_PKG_CONFIG", "PKG_INSTALLDIR", ""];
    const macroDir = ["AC_CONFIG_MACRO_DIR([m4])", ""];
    const checks = ["PKG_CHECK_MODULES([LIBECS], [ecs-cpp >= 2.1.0])"];
    if (kind !== "component") checks.push("PKG_CHECK_MODULES([LIBTHE_SEED], [the-seed >= 0.8.0])");
    checks.push("");
    const windows = [
      "AC_CHECK_HEADER([windows.h],",
      "    [LIBS=\"$LIBS\"],",
      "    [LIBS=\"$LIBS -ldl\"],",
      "    [])",
      ""
    ];
    const files = kind === "program"
      ? ["AC_CONFIG_FILES([Makefile src/Makefile])", "AC_OUTPUT"]
      : ["AC_CONFIG_FILES([Makefile src/Makefile])", `AC_CONFIG_FILES([${name}.pc])`, "AC_OUTPUT"];
    const body = kind === "program"
      ? [...head, ...macroDir, ...checks, ...windows, ...files]
      : [...head, ...pkg, ...macroDir, ...checks, ...files];
    return body.join("\n") + "\n";
  };

  for (const kind of kinds) {
    describe(kind, () => {
      it("holds exactly the files of the template tree", () => {
        const project = generate(kind);

        expect(listFiles(project)).toEqual(expectedTree(kind));
      });

      it("holds no empty file and no generic installation text", () => {
        const project = generate(kind);

        for (const file of listFiles(project)) {
          const content = fs.readFileSync(path.join(project, file), "utf8");
          expect({ file, empty: content.length === 0 }).toEqual({ file, empty: false });
          expect({ file, generic: content.includes("Installation Instructions") }).toEqual({ file, generic: false });
        }
      });

      it("has exactly one README, README.md, with the project's details", () => {
        const project = generate(kind);

        const readmes = listFiles(project).filter((file) => /^readme/i.test(path.basename(file)));
        expect(readmes).toEqual(["README.md"]);
        expect(fs.lstatSync(path.join(project, "README.md")).isFile()).toBe(true);
        expect(fs.readFileSync(path.join(project, "README.md"), "utf8")).toBe(expectedReadme(kind, ada));
      });

      it("leaves out the Web line of the README when no web address is configured", () => {
        const bare: Author = { name: "Ada Lovelace", email: "", url: "" };
        const project = generate(kind, bare);

        const readme = fs.readFileSync(path.join(project, "README.md"), "utf8");
        expect(readme).toBe(expectedReadme(kind, bare));
        expect(readme).not.toContain("Web:");
      });

      it("writes the ignore file, with the pkg-config line for components and systems", () => {
        const project = generate(kind);

        const source = ["gitignore", ".gitignore"]
          .map((file) => path.join(templatesRoot, kind, file))
          .find((file) => fs.existsSync(file));
        expect(source).toBeDefined();
        const written = fs.readFileSync(path.join(project, ".gitignore"), "utf8");
        expect(written).toBe(fs.readFileSync(source as string, "utf8"));
        expect(written.split("\n").includes("*.pc")).toBe(kind !== "program");
      });

      it("writes autogen.sh as an executable file", () => {
        const project = generate(kind);

        expect(fs.statSync(path.join(project, "autogen.sh")).mode & 0o777).toBe(0o755);
      });

      it("writes configure.ac as specified, in foreign mode", () => {
        const project = generate(kind);

        const text = fs.readFileSync(path.join(project, "configure.ac"), "utf8");
        expect(text).toContain("AM_INIT_AUTOMAKE([foreign subdir-objects])");
        expect(text).toBe(expectedConfigure(kind));
      });
    });
  }

  describe("template files", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(templatesRoot);

    const offenders = (test: (content: string) => boolean): string[] =>
      files.filter((file) => test(fs.readFileSync(file, "utf8"))).map((file) => path.relative(templatesRoot, file));

    it("have no line ending in a space or a tab", () => {
      expect(offenders((content) => content.split("\n").some((line) => /[ \t]$/.test(line)))).toEqual([]);
    });

    it("have no line holding only whitespace", () => {
      expect(offenders((content) => content.split("\n").some((line) => /^[ \t]+$/.test(line)))).toEqual([]);
    });

    it("end with exactly one newline", () => {
      expect(offenders((content) => !content.endsWith("\n") || content.endsWith("\n\n"))).toEqual([]);
    });

    it("use only the known template variables", () => {
      const unknown: string[] = [];
      for (const file of files) {
        const text = path.relative(templatesRoot, file) + "\n" + fs.readFileSync(file, "utf8");
        for (const match of text.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) {
          if (!variables.includes(match[1])) unknown.push(path.relative(templatesRoot, file) + ": " + match[1]);
        }
      }
      expect(unknown).toEqual([]);
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

  for (const [kind, name] of [
    ["component", "3d-mesh"], ["component", "class"], ["component", "a--b"], ["component", "ecs"],
    ["system", "class"], ["program", "main"], ["program", "Hello"]
  ]) {
    it(`${kind} @acme/${name} is a usage error before any prompt and changes nothing`, async () => {
      const before = snapshotTree(root);

      const result = await run(["template", kind, `@acme/${name}`]);

      expect(result.status).toBe(3);
      expect(result.stdout).toBe("");
      const reason = validateProjectName(name, kind as Kind) as string;
      const lines = result.stderr.split("\n");
      expect(lines[0]).toBe(`Error: Invalid value "@acme/${name}" for <scope>/<name>; ${reason}`);
      expect(lines[1]).toMatch(new RegExp(`^Usage: the-seed template ${kind} `));
      expect(lines[2]).toBe(`Run "the-seed help template ${kind}" for details.`);
      expect(result.stderr).not.toContain("Unexpected error");
      expect(result.prompts).toEqual([]);
      expect(snapshotTree(root)).toEqual(before);
      expect(fs.existsSync(path.join(prefix, "projects"))).toBe(false);
    });
  }

  it("a refused name is refused even when the scope is not configured", async () => {
    const before = snapshotTree(root);

    const result = await run(["template", "component", "@nope/class"]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid value \"@nope/class\" for <scope>/<name>;");
    expect(snapshotTree(root)).toEqual(before);
  });

  it("component @s/mesh.loader is created with the name as given", async () => {
    const result = await run(["template", "component", "@s/mesh.loader"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Created component @s/mesh.loader in ./mesh.loader\n");
    expect(fs.existsSync(path.join(cwd, "mesh.loader", "src", "mesh.loader.hpp"))).toBe(true);
    expect(packageNameIn(path.join(cwd, "mesh.loader"))).toBe("@s/mesh.loader");
  });

  describe("at the prompt", () => {
    /**
     * Runs the command with a stand-in for inquirer that behaves as inquirer does for `validate`: an
     * answer a question's validator refuses is not accepted and the next answer for that question is
     * taken. `answers` maps a question name to the values it is given in order.
     */
    const runInteractive = async (
      args: string[], answers: Record<string, string[]>
    ): Promise<{ status: number; shown: string[]; asked: string[] }> => {
      const queues: Record<string, string[]> = {};
      for (const key of Object.keys(answers)) queues[key] = [...answers[key]];
      const shown: string[] = [];
      const asked: string[] = [];
      const promptSpy = jest.spyOn(inquirer, "prompt").mockImplementation(((questions: unknown) => {
        const given: Record<string, string> = {};
        for (const question of questions as Array<{ name: string; validate?: (input: string) => string | boolean }>) {
          asked.push(question.name);
          for (;;) {
            const next = queues[question.name]?.shift();
            if (next === undefined) {
              return Promise.reject(new Error(`no answer left for ${question.name}`));
            }
            const verdict = question.validate === undefined ? true : question.validate(next);
            if (verdict === true) {
              given[question.name] = next;
              break;
            }
            shown.push(String(verdict));
          }
        }
        return Promise.resolve(given);
      }) as never);
      const logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
      const savedHome = process.env.HOME;
      const savedCwd = process.cwd();
      const savedExitCode = process.exitCode;
      process.env.HOME = root;
      process.exitCode = undefined;
      process.chdir(cwd);
      try {
        await (runCli as unknown as (argv: string[], dir: string, context?: { interactive?: boolean }) => Promise<void>)(
          args, configDir, { interactive: true });
        return { status: typeof process.exitCode === "number" ? process.exitCode : 0, shown, asked };
      } finally {
        process.chdir(savedCwd);
        logSpy.mockRestore();
        promptSpy.mockRestore();
        process.exitCode = savedExitCode;
        if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      }
    };

    it("template component repeats the name question with the reason and creates ./hello-world", async () => {
      const result = await runInteractive(["template", "component"], { scopeName: ["@s"], templateName: ["3d-mesh", "hello-world"] });

      expect(result.status).toBe(0);
      expect(result.shown).toEqual([validateProjectName("3d-mesh", "component")]);
      expect(fs.readdirSync(cwd)).toEqual(["hello-world"]);
      expect(packageNameIn(path.join(cwd, "hello-world"))).toBe("@s/hello-world");
      expect(fs.existsSync(path.join(cwd, "3d-mesh"))).toBe(false);
    });

    it("template system names the kind in the reason it shows", async () => {
      const result = await runInteractive(["template", "system"], { scopeName: ["@s"], templateName: ["class", "mesh.loader"] });

      expect(result.status).toBe(0);
      expect(result.shown).toEqual([
        "\"class\" cannot be used as the name of a system: its C++ name \"class\" is a reserved word."
      ]);
      expect(fs.readdirSync(cwd)).toEqual(["mesh.loader"]);
    });
  });

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
