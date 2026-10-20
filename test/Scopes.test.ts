import os from "os";
import path from "path";
import fs from "fs";
import Config from "../src/Config";
import Scopes from "../src/Scopes";
import * as ScopesModule from "../src/Scopes";

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
