import fs from "fs";
import Config from "../src/Config";
import Scopes from "../src/Scopes";

const configDir = "./ScopesTestDir";
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
  beforeAll(() => {
    fs.mkdirSync(configDir);
  });

  const config = new Config(configDir);
  config.loadConfig();
  const scopes = new Scopes(config);

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
    fs.rmdirSync(configDir, { recursive: true })
  });
});
