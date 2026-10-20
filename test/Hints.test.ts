/**
 * Tests for the hint sentences. This file holds the group `hint texts`; later groups check the
 * source for command lines that are not quoted and follow each printed hint.
 *
 * Interfaces this file expects: `src/cli/Hints.ts` exports the functions `addScopeHint()`,
 * `editScopeHint(scope)`, `createCertHint(scope)`, `replaceCertHint(scope)`,
 * `chooseScopeHint(scopes: string[])`, `forceHint(scope)`, `listScopesHint()`,
 * `helpHint(command?, subcommand?)`, `buildWindowsHint()`, `fullBuildHint()` and
 * `resignHint(path?)`, each returning one sentence.
 */
import {
  addScopeHint,
  editScopeHint,
  createCertHint,
  replaceCertHint,
  chooseScopeHint,
  forceHint,
  listScopesHint,
  helpHint,
  buildWindowsHint,
  fullBuildHint,
  resignHint,
} from "../src/cli/Hints";

describe("hint texts", () => {
  it("addScopeHint", () => {
    expect(addScopeHint()).toBe("Add one with \"the-seed scopes add\".");
  });

  it("editScopeHint", () => {
    expect(editScopeHint("@a")).toBe("Set the author's name with \"the-seed scopes edit\" (scope @a).");
  });

  it("createCertHint", () => {
    expect(createCertHint("@a")).toBe("Create one with \"the-seed signing create-cert --scope @a\".");
  });

  it("replaceCertHint", () => {
    expect(replaceCertHint("@a")).toBe("Create a new one with \"the-seed signing create-cert --scope @a --force\".");
  });

  it("chooseScopeHint", () => {
    expect(chooseScopeHint(["@a", "@b"])).toBe(
      "Several scopes are configured; choose one with --scope <scope>. Configured scopes: @a, @b."
    );
  });

  it("forceHint", () => {
    expect(forceHint("@a")).toBe("A certificate already exists for scope @a; give --force to replace it.");
  });

  it("listScopesHint", () => {
    expect(listScopesHint()).toBe("Scopes are listed with \"the-seed scopes list\".");
  });

  it("helpHint without arguments, with a command and with a command and subcommand", () => {
    expect(helpHint()).toBe("Run \"the-seed help\" for details.");
    expect(helpHint("signing")).toBe("Run \"the-seed help signing\" for details.");
    expect(helpHint("signing", "sign")).toBe("Run \"the-seed help signing sign\" for details.");
  });

  it("buildWindowsHint", () => {
    expect(buildWindowsHint()).toBe("Cross-compile the project first with \"the-seed build windows\".");
  });

  it("fullBuildHint", () => {
    expect(fullBuildHint()).toBe("Run a full build (\"the-seed build native\" or \"the-seed build windows\").");
  });

  it("resignHint with and without a path", () => {
    expect(resignHint()).toBe("Sign the file again with \"the-seed signing sign <path>\".");
    expect(resignHint("./app.exe")).toBe("Sign the file again with \"the-seed signing sign ./app.exe\".");
  });

  it("every hint is one line", () => {
    const hints = [
      addScopeHint(),
      editScopeHint("@a"),
      createCertHint("@a"),
      replaceCertHint("@a"),
      chooseScopeHint(["@a", "@b"]),
      forceHint("@a"),
      listScopesHint(),
      helpHint(),
      buildWindowsHint(),
      fullBuildHint(),
      resignHint(),
    ];
    for (const hint of hints) {
      expect(hint).not.toContain("\n");
      expect(hint.endsWith(".")).toBe(true);
    }
  });
});
