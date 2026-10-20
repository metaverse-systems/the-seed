/**
 * Tests for the exit-status table and the error classes of the command-line layer. This file
 * holds the group `scheme`; later groups of this file run the commands end to end.
 *
 * Interfaces this file expects from `src/cli/ExitStatus.ts`:
 *
 * - `EXIT_STATUSES: Array<{ status: string; meaning: string }>`.
 * - `new CliError(status: number, message: string, options?: { hint?: string; usage?: string })`
 *   with the readable fields `status`, `message`, `hint` and `usage`.
 * - `new UsageError(message: string, details: { argument: string; command: string;
 *   subcommand?: string; usage: string })`: status 3, the fields `argument`, `command`,
 *   `subcommand`, `usage` (the complete usage line, as given) and `hint` set to the help hint
 *   `helpHint(command, subcommand)`.
 * - `new MissingError(message: string, options?: { hint?: string })`: status 2.
 * - `new FailedError(message: string, options?: { hint?: string; reported?: boolean })`: status
 *   1, with `reported` false when not given.
 * - Each class sets `name` to its own name and works with `instanceof` after compilation.
 */
import { EXIT_STATUSES, CliError, UsageError, MissingError, FailedError } from "../src/cli/ExitStatus";
import { helpHint } from "../src/cli/Hints";

describe("scheme", () => {
  describe("EXIT_STATUSES", () => {
    it("has the rows 0, 1, 2, 3, 4 and 128+N in order", () => {
      expect(EXIT_STATUSES.map((row) => row.status)).toEqual(["0", "1", "2", "3", "4", "128+N"]);
    });

    it("gives each row the meaning of the scheme", () => {
      const meanings = EXIT_STATUSES.map((row) => row.meaning);
      expect(meanings[0]).toMatch(/did what was asked/i);
      expect(meanings[0]).toMatch(/help/i);
      expect(meanings[0]).toMatch(/valid/i);
      expect(meanings[1]).toMatch(/ran/i);
      expect(meanings[1]).toMatch(/failure/i);
      expect(meanings[1]).toMatch(/declined to overwrite/i);
      expect(meanings[1]).toMatch(/unexpected internal error/i);
      expect(meanings[2]).toMatch(/missing or unusable/i);
      expect(meanings[2]).toMatch(/scopes/i);
      expect(meanings[2]).toMatch(/certificate/i);
      expect(meanings[3]).toMatch(/usage error/i);
      expect(meanings[3]).toMatch(/cannot interpret/i);
      expect(meanings[4]).toMatch(/verification only/i);
      expect(meanings[4]).toMatch(/not trusted/i);
      expect(meanings[5]).toMatch(/signal N/);
      expect(meanings[5]).toMatch(/130/);
    });

    it("keeps every meaning on one line", () => {
      for (const row of EXIT_STATUSES) {
        expect(row.meaning).not.toContain("\n");
        expect(row.meaning.trim()).toBe(row.meaning);
        expect(row.meaning.length).toBeGreaterThan(10);
      }
    });
  });

  describe("UsageError", () => {
    const details = {
      argument: "--zz",
      command: "signing",
      subcommand: "sign",
      usage: "Usage: the-seed signing sign <path> [--scope <scope>]",
    };
    const error = new UsageError("Unknown option \"--zz\" for \"the-seed signing sign\".", details);

    it("has status 3 and carries the argument, command, subcommand, usage line and help hint", () => {
      expect(error.status).toBe(3);
      expect(error.argument).toBe("--zz");
      expect(error.command).toBe("signing");
      expect(error.subcommand).toBe("sign");
      expect(error.usage).toBe(details.usage);
      expect(error.hint).toBe(helpHint("signing", "sign"));
      expect(error.hint).toBe("Run \"the-seed help signing sign\" for details.");
    });

    it("has a help hint for the command alone and for no command", () => {
      const commandOnly = new UsageError("m", { argument: "x", command: "build", usage: "Usage: the-seed build" });
      expect(commandOnly.subcommand).toBeUndefined();
      expect(commandOnly.hint).toBe("Run \"the-seed help build\" for details.");
    });

    it("is a CliError and an Error that instanceof recognises, with its own name", () => {
      expect(error).toBeInstanceOf(UsageError);
      expect(error).toBeInstanceOf(CliError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("UsageError");
    });

    it("has a one-line message without an Error: prefix", () => {
      expect(error.message).toBe("Unknown option \"--zz\" for \"the-seed signing sign\".");
      expect(error.message).not.toContain("\n");
      expect(error.message.startsWith("Error:")).toBe(false);
    });
  });

  describe("MissingError", () => {
    it("has status 2 and carries a hint", () => {
      const error = new MissingError("No scopes are configured.", { hint: "Add one with \"the-seed scopes add\"." });
      expect(error.status).toBe(2);
      expect(error.message).toBe("No scopes are configured.");
      expect(error.hint).toBe("Add one with \"the-seed scopes add\".");
      expect(error).toBeInstanceOf(MissingError);
      expect(error).toBeInstanceOf(CliError);
      expect(error.name).toBe("MissingError");
    });

    it("has no hint when none is given", () => {
      expect(new MissingError("gone").hint).toBeUndefined();
    });
  });

  describe("FailedError", () => {
    it("has status 1 and is not reported unless said so", () => {
      const error = new FailedError("Build failed.");
      expect(error.status).toBe(1);
      expect(error.reported).toBe(false);
      expect(error).toBeInstanceOf(FailedError);
      expect(error).toBeInstanceOf(CliError);
      expect(error.name).toBe("FailedError");
    });

    it("keeps reported and the hint", () => {
      const error = new FailedError("Build failed.", { reported: true, hint: "Try again." });
      expect(error.reported).toBe(true);
      expect(error.hint).toBe("Try again.");
    });
  });

  describe("CliError", () => {
    it("keeps the status it is given", () => {
      for (const status of [1, 2, 3, 4, 130]) {
        const error = new CliError(status, "Something happened.");
        expect(error.status).toBe(status);
        expect(error.message).toBe("Something happened.");
        expect(error.hint).toBeUndefined();
        expect(error.usage).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        expect(error.name).toBe("CliError");
      }
    });

    it("keeps a hint and a usage line", () => {
      const error = new CliError(3, "m", { hint: "h.", usage: "Usage: the-seed" });
      expect(error.hint).toBe("h.");
      expect(error.usage).toBe("Usage: the-seed");
    });

    it("is not a UsageError, MissingError or FailedError", () => {
      const error = new CliError(2, "m");
      expect(error).not.toBeInstanceOf(UsageError);
      expect(error).not.toBeInstanceOf(MissingError);
      expect(error).not.toBeInstanceOf(FailedError);
    });
  });
});
