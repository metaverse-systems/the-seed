import os from "os";
import path from "path";
import fs from "fs";
import Config from "../src/Config";
import Scopes from "../src/Scopes";
import * as ScopesModule from "../src/Scopes";
import * as Index from "../src/index";

// Looked up on the module so that this file compiles whether or not the export exists.
const validateScopeName = (ScopesModule as unknown as { validateScopeName: (name: string) => string | null })
  .validateScopeName;

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "scopes-test-"));
}

const scopeName1 = "@scope-" + Math.random().toString(36).substr(2, 5);
const scopeName2 = "scope-" + Math.random().toString(36).substr(2, 5);

const author1 = {
  authorName: "Person1",
  authorEmail: "person1@domain.com",
  authorURL: "https://domain.com/person1"
};

const author2 = {
  authorName: "Person1",
  authorEmail: "person1@domain.com",
  authorURL: "https://domain.com/person1"
};

describe("test Scopes", () => {
  let configDir: string;
  let config: Config;
  let scopes: Scopes;

  beforeAll(() => {
    configDir = createTempDir();
    config = new Config(configDir);
    config.loadConfig();
    scopes = new Scopes(config);
  });

  it("should return empty list", () => {
    expect(scopes.getScopes().length).toEqual(0);
  });

  it("should create scopes", () => {
    scopes.createOrEditScope({...author1, scopeName: scopeName1});
    scopes.createOrEditScope({...author2, scopeName: scopeName2});

    expect(scopes.getScopes().includes(scopeName1)).toEqual(true);
    expect(scopes.getScopes().includes("@" + scopeName2)).toEqual(true);
  });

  it("should delete scopes", () => {
    scopes.deleteScope(scopeName1);
    scopes.deleteScope(scopeName2);

    expect(scopes.getScopes().includes(scopeName1)).toEqual(false);
    expect(scopes.getScopes().includes("@" + scopeName2)).toEqual(false);
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });
});

describe("Scopes on a file without scopes", () => {
  let configDir: string;

  beforeAll(() => {
    configDir = createTempDir();
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "p") }));
  });

  it("getScopes on a file without scopes returns []", () => {
    const scopes = new Scopes(new Config(configDir));
    expect(scopes.getScopes()).toEqual([]);
  });

  afterAll(() => {
    fs.rmSync(configDir, { recursive: true });
  });
});

describe("validateScopeName", () => {
  const EMPTY = "A scope name cannot be empty.";
  const SLASH = "A scope name cannot contain \"/\".";
  const WHITESPACE = "A scope name cannot contain spaces or other whitespace.";

  it.each(["a", "@a", "@my-scope"])("accepts %p", (name) => {
    expect(validateScopeName(name)).toBeNull();
  });

  it.each(["", "@"])("refuses %p as empty", (name) => {
    expect(validateScopeName(name)).toBe(EMPTY);
  });

  it.each(["a/b", "@a/b"])("refuses %p for the slash", (name) => {
    expect(validateScopeName(name)).toBe(SLASH);
  });

  it.each(["a b", "@a\tb"])("refuses %p for the whitespace", (name) => {
    expect(validateScopeName(name)).toBe(WHITESPACE);
  });
});

// Interfaces fixed here where the contracts leave them open:
//   - `ScopeNameError` is exported from `src/Scopes.ts` and from the package index; its message is the
//     reason `validateScopeName` gives for the name as typed
//   - the name question of `askNewScope()` is the one whose `name` is `scopeName`; its `validate`
//     returns the reason (a string) for an invalid name and `true` for a valid one
//   - an invalid name is refused only when the scope does not exist yet
describe("Scopes name checks", () => {
  let configDir: string;
  let config: Config;
  let scopes: Scopes;

  const answers = (scopeName: string) => ({ ...author1, scopeName });
  const scopesOf = (): Record<string, unknown> => ({ ...config.config.scopes });
  const errorClass = (): (new (...args: never[]) => Error) | undefined =>
    (ScopesModule as unknown as { ScopeNameError?: new (...args: never[]) => Error }).ScopeNameError;

  beforeEach(() => {
    configDir = createTempDir();
    config = new Config(configDir);
    config.loadConfig();
    scopes = new Scopes(config);
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it.each(["", "a b", "a/b"])("createOrEditScope refuses %p for a new scope and leaves the configuration unchanged", (name) => {
    const before = JSON.stringify(config.config);
    const Expected = errorClass();
    expect(Expected).toBeDefined();
    let thrown: unknown;
    try {
      scopes.createOrEditScope(answers(name));
    } catch (error: unknown) {
      thrown = error;
    }
    expect(Expected !== undefined && thrown instanceof Expected).toBe(true);
    expect((thrown as Error).message).toBe(validateScopeName(name));
    expect(JSON.stringify(config.config)).toBe(before);
  });

  it("still edits an existing scope whose name is not valid, under the same key", () => {
    config.config.scopes["@odd name"] = { author: { name: "Old", email: "old@example.com", url: "" } };
    scopes.createOrEditScope({ ...author1, scopeName: "@odd name" });
    expect(Object.keys(scopesOf())).toEqual(["@odd name"]);
    expect(config.config.scopes["@odd name"].author.name).toBe(author1.authorName);
  });

  it("the name question validates the name as typed", () => {
    const question = scopes.askNewScope().find((q) => q.name === "scopeName") as
      | { validate?: (input: string) => string | boolean }
      | undefined;
    expect(question?.validate).toBeDefined();
    const validate = question?.validate as (input: string) => string | boolean;
    for (const bad of ["", "a b", "a/b"]) {
      expect(validate(bad)).toBe(validateScopeName(bad));
      expect(typeof validate(bad)).toBe("string");
    }
    expect(validate("a")).toBe(true);
  });

  it("exports ScopeNameError and validateScopeName from the package index", () => {
    const exported = Index as unknown as { ScopeNameError?: unknown; validateScopeName?: unknown };
    expect(exported.ScopeNameError).toBe(errorClass());
    expect(exported.validateScopeName).toBe(validateScopeName);
  });
});
