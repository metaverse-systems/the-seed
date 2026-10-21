/*
 * Tests that every minimum library version comes from REQUIRED_VERSIONS.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - Projects are generated with `Template.createPackage(scope, name, parentDir, now)` after setting
 *   `Template.type` to the kind, in a scratch directory, with the scope "@acme" configured in a
 *   scratch configuration directory.
 * - A library counts as linked when `src/Makefile.am` mentions its `LIBECS_LIBS` or
 *   `LIBTHE_SEED_LIBS` variable (written `$(...)` or `${...}`); it is checked by a
 *   `PKG_CHECK_MODULES` line in `configure.ac` and, for component and system, named in the
 *   `Requires:` line of the pkg-config file `<name>.pc.in`.
 * - The mocked `RequiredVersions` module is substituted with `jest.doMock` and `Template` is
 *   loaded in `jest.isolateModules`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import Config from "../src/Config";
import { requiredLibEcsVersion, requiredLibTheSeedVersion } from "../src/Dependencies";

const root = path.join(__dirname, "..");

interface RequiredVersionsModule {
  REQUIRED_VERSIONS: Readonly<{ "ecs-cpp": string; "the-seed": string }>;
}

// Loaded when a case runs, so that this file still loads while the module is absent.
function requiredVersions(): RequiredVersionsModule["REQUIRED_VERSIONS"] {
  return jest.requireActual<RequiredVersionsModule>("../src/RequiredVersions").REQUIRED_VERSIONS;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function readFile(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("required libthe-seed version", () => {
  const constraint = `the-seed >= ${requiredLibTheSeedVersion}`;

  it("native/binding.gyp asks for the same version in every pkg-config call", () => {
    const file = "native/binding.gyp";
    const lines = readFile(file).split("\n").filter((line) => line.includes("pkg-config"));
    expect(lines.length).toBeGreaterThan(0);
    const wrong = lines.filter((line) => !line.includes(constraint));
    if (wrong.length > 0) {
      throw new Error(
        `${file} has pkg-config calls that do not ask for '${constraint}':\n` +
        wrong.map((line) => line.trim()).join("\n")
      );
    }
  });
});

describe("required versions", () => {
  it("REQUIRED_VERSIONS holds the two minimum versions", () => {
    expect(requiredVersions()).toEqual({ "ecs-cpp": "2.1.0", "the-seed": "0.8.0" });
  });

  it("REQUIRED_VERSIONS is frozen", () => {
    expect(Object.isFrozen(requiredVersions())).toBe(true);
  });

  it("the dependency check asks for the same versions", () => {
    expect(requiredLibEcsVersion).toBe(requiredVersions()["ecs-cpp"]);
    expect(requiredLibTheSeedVersion).toBe(requiredVersions()["the-seed"]);
  });

  it("no TypeScript file under src/ other than RequiredVersions.ts writes either version number", () => {
    const own = path.join(root, "src", "RequiredVersions.ts");
    expect(fs.existsSync(own)).toBe(true);
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(root, "src"))) {
      if (file === own) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const version of ["2.1.0", "0.8.0"]) {
        if (text.includes(version)) offenders.push(`${path.relative(root, file)} contains ${version}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

type Kind = "component" | "system" | "program";
const kinds: Kind[] = ["component", "system", "program"];

interface Versions { "ecs-cpp": string; "the-seed": string }
interface TemplateLike {
  type: Kind;
  createPackage: (scope: string, name: string, parentDir: string, now: Date) => string;
}
type TemplateConstructor = new (config: Config) => TemplateLike;

function versionLike(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...versionLike(full));
    } else {
      const matches = fs.readFileSync(full, "utf8").match(/[0-9]+\.[0-9]+\.[0-9]+/g) ?? [];
      for (const match of matches) {
        if (match !== "0.0.1") found.push(`${path.relative(root, full)}: ${match}`);
      }
    }
  }
  return found;
}

function linkedLibraries(makefile: string): Array<"ecs-cpp" | "the-seed"> {
  const linked: Array<"ecs-cpp" | "the-seed"> = [];
  if (/[$][({]LIBECS_LIBS[)}]/.test(makefile)) linked.push("ecs-cpp");
  if (/[$][({]LIBTHE_SEED_LIBS[)}]/.test(makefile)) linked.push("the-seed");
  return linked;
}

describe("library versions in generated projects", () => {
  let scratch: string;
  let config: Config;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "required-versions-"));
    config = new Config(path.join(scratch, "config"));
    config.config.scopes["@acme"] = {
      author: { name: "Ada Lovelace", email: "ada@example.com", url: "https://acme.example" }
    };
    config.saveConfig();
    fs.mkdirSync(path.join(scratch, "work"));
  });

  afterEach(() => {
    jest.resetModules();
    jest.dontMock("../src/RequiredVersions");
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function generate(TemplateClass: TemplateConstructor, kind: Kind, name: string): string {
    const template = new TemplateClass(config);
    template.type = kind;
    return template.createPackage("@acme", name, path.join(scratch, "work"), new Date(2026, 5, 1));
  }

  function loadTemplate(versions?: Versions): TemplateConstructor {
    let loaded: TemplateConstructor | undefined;
    jest.isolateModules(() => {
      if (versions) {
        jest.doMock("../src/RequiredVersions", () => ({ REQUIRED_VERSIONS: Object.freeze({ ...versions }) }));
      }
      loaded = (jest.requireActual("../src/Template") as { default: TemplateConstructor }).default;
    });
    if (!loaded) throw new Error("Template did not load");
    return loaded;
  }

  function pcRequires(project: string, name: string): string {
    const lines = fs.readFileSync(path.join(project, `${name}.pc.in`), "utf8").split("\n");
    return lines.filter((line) => line.startsWith("Requires:")).join("\n");
  }

  function checkedModules(project: string): string[] {
    const text = fs.readFileSync(path.join(project, "configure.ac"), "utf8");
    return text.split("\n").filter((line) => line.includes("PKG_CHECK_MODULES"));
  }

  it("no file under templates/ holds a version number other than 0.0.1", () => {
    expect(versionLike(path.join(root, "templates"))).toEqual([]);
  });

  it.each(kinds)("a new %s checks and requires every library it links at the required versions", (kind) => {
    const versions = requiredVersions();
    const project = generate(loadTemplate(), kind, "demo");
    const linked = linkedLibraries(fs.readFileSync(path.join(project, "src", "Makefile.am"), "utf8"));
    expect(linked.length).toBeGreaterThan(0);

    const checks = checkedModules(project);
    expect(checks).toHaveLength(linked.length);
    for (const library of linked) {
      const variable = library === "ecs-cpp" ? "LIBECS" : "LIBTHE_SEED";
      const matching = checks.filter((line) =>
        line.includes(`PKG_CHECK_MODULES([${variable}], [${library} >= ${versions[library]}])`));
      expect(matching).toHaveLength(1);
    }

    if (kind !== "program") {
      const expected = "Requires: " + linked.map((library) => `${library} >= ${versions[library]}`).join(", ");
      expect(pcRequires(project, "demo")).toBe(expected);
    }
  });

  it("a new component requires ecs-cpp only and a new system requires both libraries", () => {
    const versions = requiredVersions();
    const Template = loadTemplate();
    const component = generate(Template, "component", "part");
    const system = generate(Template, "system", "mover");
    expect(pcRequires(component, "part")).toBe(`Requires: ecs-cpp >= ${versions["ecs-cpp"]}`);
    expect(pcRequires(system, "mover"))
      .toBe(`Requires: ecs-cpp >= ${versions["ecs-cpp"]}, the-seed >= ${versions["the-seed"]}`);
  });

  it.each(["system", "program"] as Kind[])("a new %s asks for the mocked versions everywhere", (kind) => {
    const project = generate(loadTemplate({ "ecs-cpp": "9.8.7", "the-seed": "6.5.4" }), kind, "demo");
    const configure = fs.readFileSync(path.join(project, "configure.ac"), "utf8");
    expect(configure).toContain("[ecs-cpp >= 9.8.7]");
    expect(configure).toContain("[the-seed >= 6.5.4]");
    if (kind === "system") {
      expect(pcRequires(project, "demo")).toBe("Requires: ecs-cpp >= 9.8.7, the-seed >= 6.5.4");
    }
    const everything: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else everything.push(fs.readFileSync(full, "utf8"));
      }
    };
    walk(project);
    const text = everything.join("\n");
    expect(text).not.toContain("2.1.0");
    expect(text).not.toContain("0.8.0");
  });
});
