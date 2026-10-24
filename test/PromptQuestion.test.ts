/*
 * The prompt methods return `PromptQuestion[]`, the type the command line passes to `inquirer.prompt`.
 *
 * Choices where the contract is open:
 * - "Returns `PromptQuestion[]`" is checked as assignability both ways between the method's return type and
 *   `PromptQuestion[]`, by the type checker (the typecheck stage, and ts-jest when this file is compiled).
 * - That `inquirer.prompt` accepts each list is checked by the type checker too: the calls are written inside
 *   functions the cases never call, so nothing is prompted.
 * - The run-time checks use a configuration with two scopes, so every "list" prompt has choices.
 */
import fs from "fs";
import os from "os";
import path from "path";
import inquirer from "inquirer";
import Config from "../src/Config";
import ResourcePak from "../src/ResourcePak";
import Scopes from "../src/Scopes";
import Template from "../src/Template";
import { PromptQuestion } from "../src/types";

/** True when each of A and B is assignable to the other. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("PromptQuestion", () => {
  let configDir: string;
  let config: Config;
  let scopes: Scopes;
  let resourcePak: ResourcePak;
  let template: Template;

  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-question-"));
    const author = { name: "Author", email: "author@example.com", url: "https://example.com" };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      prefix: path.join(configDir, "prefix"),
      scopes: { "@first": { author }, "@second": { author } },
    }));
    config = new Config(configDir);
    scopes = new Scopes(config);
    resourcePak = new ResourcePak(config);
    template = new Template(config);
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("is the return type of every prompt method (checked by the type checker)", () => {
    const sameType: [
      Equal<ReturnType<Config["getQuestions"]>, PromptQuestion[]>,
      Equal<ReturnType<Scopes["askWhichScope"]>, PromptQuestion[]>,
      Equal<ReturnType<Scopes["askNewScope"]>, PromptQuestion[]>,
      Equal<ReturnType<Scopes["askEditScope"]>, PromptQuestion[]>,
      Equal<ReturnType<Scopes["getQuestions"]>, PromptQuestion[]>,
      Equal<ReturnType<ResourcePak["askName"]>, PromptQuestion[]>,
      Equal<ReturnType<Template["askName"]>, PromptQuestion[]>,
    ] = [true, true, true, true, true, true, true];
    expect(sameType.every((same) => same)).toBe(true);
  });

  it("is accepted by inquirer.prompt for every prompt method (checked by the type checker; nothing is prompted)", () => {
    const prompts: (() => Promise<unknown>)[] = [
      () => inquirer.prompt(config.getQuestions()),
      () => inquirer.prompt(scopes.askWhichScope()),
      () => inquirer.prompt(scopes.askNewScope()),
      () => inquirer.prompt(scopes.askEditScope()),
      () => inquirer.prompt(scopes.askEditScope({ name: "Author" })),
      () => inquirer.prompt(scopes.getQuestions({})),
      () => inquirer.prompt(resourcePak.askName()),
      () => inquirer.prompt(template.askName()),
    ];
    const anyList = (questions: PromptQuestion[]): Promise<unknown> => inquirer.prompt(questions);
    expect(prompts).toHaveLength(8);
    expect(typeof anyList).toBe("function");
  });

  describe("the questions returned", () => {
    const lists: [string, () => PromptQuestion[]][] = [
      ["Config.getQuestions", () => config.getQuestions()],
      ["Scopes.askWhichScope", () => scopes.askWhichScope()],
      ["Scopes.askNewScope", () => scopes.askNewScope()],
      ["Scopes.askEditScope without defaults", () => scopes.askEditScope()],
      ["Scopes.askEditScope with defaults", () => scopes.askEditScope({ name: "Author", email: "author@example.com", url: "https://example.com" })],
      ["Scopes.getQuestions without a scope name", () => scopes.getQuestions({})],
      ["Scopes.getQuestions with a scope name", () => scopes.getQuestions({ scopeName: "@first" })],
      ["ResourcePak.askName", () => resourcePak.askName()],
      ["Template.askName", () => template.askName()],
    ];

    it.each(lists)("%s has a name and a message for every question", (_method, questions) => {
      const list = questions();
      expect(list.length).toBeGreaterThan(0);
      for (const question of list) {
        expect(typeof question.name).toBe("string");
        expect(question.name).not.toBe("");
        expect(typeof question.message).toBe("string");
        expect(question.message).not.toBe("");
      }
    });

    it.each(lists)("%s has only text prompts and list prompts with choices", (_method, questions) => {
      for (const question of questions()) {
        if (question.type === undefined) {
          continue;
        }
        expect(question.type).toBe("list");
        expect(Array.isArray(question.choices)).toBe(true);
      }
    });

    it.each(lists)("%s names each answer once", (_method, questions) => {
      const names = questions().map((question) => question.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  it("accepts a good scope name in askNewScope's validator and gives the reason for a bad one", () => {
    const validate = scopes.askNewScope()[0].validate;
    if (validate === undefined) {
      throw new Error("askNewScope's first question has no validator");
    }
    expect(validate("@good")).toBe(true);
    expect(typeof validate("@bad name")).toBe("string");
    expect(typeof validate("@")).toBe("string");
  });
});
