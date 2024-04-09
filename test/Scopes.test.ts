import os from "os";
import path from "path";
import fs from "fs";
import Config from "../src/Config";
import Scopes from "../src/Scopes";

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
