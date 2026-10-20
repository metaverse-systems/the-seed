/**
 * Tests for the choice of a scope for the commands that use a certificate.
 *
 * Interface this file expects from `src/cli/ScopeChoice.ts`: `chooseScope(signing: Signing,
 * requested: string | undefined, interactive: boolean): Promise<string>`, returning the scope with
 * its "@". A `requested` scope is accepted with or without the "@". When several scopes are
 * configured and prompting is allowed, the choice is made with one `inquirer.prompt` call whose
 * answer is read from the field `scope` (a list question). Failures are `MissingError` (status 2)
 * and `UsageError` (status 3) from `src/cli/ExitStatus.ts`; the message of the usage error is
 * `chooseScopeHint(scopes)`, and the "no scopes" error carries `addScopeHint()` in its `hint`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { chooseScope } from "../src/cli/ScopeChoice";
import { MissingError, UsageError } from "../src/cli/ExitStatus";
import { addScopeHint, chooseScopeHint } from "../src/cli/Hints";

const mockPrompt = jest.fn();
jest.mock("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

const created: string[] = [];

function signingWith(scopes: string[]): Signing {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-choice-"));
  created.push(configDir);
  const entries: Record<string, { author: { name: string; email: string; url: string } }> = {};
  for (const scope of scopes) {
    entries[scope] = { author: { name: "Author " + scope, email: "a@example.com", url: "" } };
  }
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes: entries }));
  return new Signing(configDir);
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the choice to fail");
}

beforeEach(() => {
  mockPrompt.mockReset();
});

afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("chooseScope with a requested scope", () => {
  it("returns a configured scope given with its @, without a prompt", async () => {
    const signing = signingWith(["@a", "@b"]);
    await expect(chooseScope(signing, "@a", true)).resolves.toBe("@a");
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("adds the @ to a configured scope given without it", async () => {
    const signing = signingWith(["@a", "@b"]);
    await expect(chooseScope(signing, "a", false)).resolves.toBe("@a");
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("refuses a scope that is not configured with a MissingError naming it and listing the configured scopes", async () => {
    const signing = signingWith(["@a", "@b"]);
    const error = await failureOf(chooseScope(signing, "@nope", true));
    expect(error).toBeInstanceOf(MissingError);
    expect((error as MissingError).status).toBe(2);
    expect((error as MissingError).message).toContain("@nope");
    expect((error as MissingError).message).toContain("Configured scopes: @a, @b.");
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("refuses a scope when none is configured, saying so and giving the add-scope hint", async () => {
    const signing = signingWith([]);
    const error = await failureOf(chooseScope(signing, "@nope", true));
    expect(error).toBeInstanceOf(MissingError);
    expect((error as MissingError).status).toBe(2);
    expect((error as MissingError).message).toContain("No scopes are configured.");
    expect((error as MissingError).hint).toBe(addScopeHint());
  });
});

describe("chooseScope without a requested scope", () => {
  it("fails with a MissingError and the add-scope hint when no scope is configured", async () => {
    for (const interactive of [true, false]) {
      const signing = signingWith([]);
      const error = await failureOf(chooseScope(signing, undefined, interactive));
      expect(error).toBeInstanceOf(MissingError);
      expect((error as MissingError).status).toBe(2);
      expect((error as MissingError).hint).toBe(addScopeHint());
    }
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("returns the only scope without a prompt, interactive or not", async () => {
    for (const interactive of [true, false]) {
      await expect(chooseScope(signingWith(["@only"]), undefined, interactive)).resolves.toBe("@only");
    }
    expect(mockPrompt).not.toHaveBeenCalled();
  });

  it("asks with a list prompt when several scopes are configured and prompting is allowed", async () => {
    mockPrompt.mockResolvedValue({ scope: "@b" });
    await expect(chooseScope(signingWith(["@a", "@b"]), undefined, true)).resolves.toBe("@b");
    expect(mockPrompt).toHaveBeenCalledTimes(1);
    const question = mockPrompt.mock.calls[0][0][0];
    expect(question.type).toBe("list");
    expect(question.name).toBe("scope");
    expect(question.choices).toEqual(["@a", "@b"]);
  });

  it("fails with a UsageError (status 3) listing the scopes when several are configured and prompting is not allowed", async () => {
    const error = await failureOf(chooseScope(signingWith(["@a", "@b"]), undefined, false));
    expect(error).toBeInstanceOf(UsageError);
    expect((error as UsageError).status).toBe(3);
    expect((error as UsageError).message).toBe(
      "Several scopes are configured; choose one with --scope <scope>. Configured scopes: @a, @b."
    );
    expect((error as UsageError).message).toBe(chooseScopeHint(["@a", "@b"]));
    expect(mockPrompt).not.toHaveBeenCalled();
  });
});
