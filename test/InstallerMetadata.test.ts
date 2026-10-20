/*
 * Cases for the pure installer metadata functions (src/InstallerMetadata.ts).
 *
 * Interfaces fixed here where the contract leaves them open:
 * - `parsePackageVersion(raw)` returns `{ major, minor, patch, prerelease, build, raw }` with numbers
 *   for the three parts, `null` for an absent prerelease or build, and `raw` the input unchanged.
 * - `installerVersion(v)` returns `{ version, note }`; `note` is `null` when no suffix was dropped.
 * - Messages of `xmlAttribute` and `checkFolderName` are checked for the offending value or
 *   character (and `U+XXXX` for characters XML cannot carry); the messages of `parsePackageVersion`
 *   and `installerVersion` are checked exactly as the contract words them.
 * - A lone surrogate is reported as the code unit, for example `U+D800`.
 */
import crypto from "crypto";
import { readWxs } from "./helpers/WxsReader";
import { sanitizeId } from "../src/Installer";
import { InstallerMetadataError as ExportedError } from "../src/index";
import {
  InstallerMetadataError,
  xmlAttribute,
  parsePackageVersion,
  installerVersion,
  checkFolderName,
  fileIdentifier,
} from "../src/InstallerMetadata";

/** Reads an attribute value back through the independent reader. */
function readBack(value: string): string {
  const elements = readWxs("<E a=\"" + xmlAttribute(value) + "\" />");
  return elements[0].attributes.a;
}

describe("InstallerMetadataError", () => {
  it("is an Error exported from the package index", () => {
    expect(ExportedError).toBe(InstallerMetadataError);
    expect(new InstallerMetadataError("x")).toBeInstanceOf(Error);
    expect(new InstallerMetadataError("x").message).toBe("x");
  });
});

describe("xmlAttribute", () => {
  it("escapes the five characters, the ampersand first", () => {
    expect(xmlAttribute("&")).toBe("&amp;");
    expect(xmlAttribute("<")).toBe("&lt;");
    expect(xmlAttribute(">")).toBe("&gt;");
    expect(xmlAttribute("\"")).toBe("&quot;");
    expect(xmlAttribute("'")).toBe("&apos;");
    expect(xmlAttribute("&lt;")).toBe("&amp;lt;");
  });

  it("leaves other text unchanged", () => {
    expect(xmlAttribute("plain-name_1.0")).toBe("plain-name_1.0");
    expect(xmlAttribute("")).toBe("");
  });

  const values = [
    "hello",
    "prödüct",
    "a&b",
    "a'b",
    "東京",
    "Smith & Jones <sales@example.com>",
    "O'Brien \"Ltd\"",
    "Zoë Ωmega 東京",
    "ü&'q.txt",
    "x<y>.txt",
    "a-b.dll",
    "a_b.dll",
    "tab\there\nnew line\r",
    "emoji \u{1F600} pair",
    "&amp; already",
  ];
  it.each(values)("reads back exactly through the independent reader: %j", (value) => {
    expect(readBack(value)).toBe(value);
  });

  const refused: Array<[string, string, string]> = [
    ["U+0001", "a\u0001b", "U+0001"],
    ["U+0000", "a\u0000b", "U+0000"],
    ["U+0008", "a\u0008b", "U+0008"],
    ["U+000B", "a\u000Bb", "U+000B"],
    ["U+000C", "a\u000Cb", "U+000C"],
    ["U+000E", "a\u000Eb", "U+000E"],
    ["U+001F", "a\u001Fb", "U+001F"],
    ["U+FFFE", "a￾b", "U+FFFE"],
    ["U+FFFF", "a￿b", "U+FFFF"],
    ["a lone high surrogate", "a\uD800b", "U+D800"],
    ["a lone low surrogate", "a\uDC00b", "U+DC00"],
    ["a high surrogate at the end", "ab\uD83D", "U+D83D"],
  ];
  it.each(refused)("refuses %s naming the character", (_label, value, code) => {
    let thrown: unknown;
    try {
      xmlAttribute(value);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstallerMetadataError);
    expect((thrown as Error).message).toContain(code);
  });
});

describe("parsePackageVersion", () => {
  it("reads the three numbers, the prerelease and the build", () => {
    expect(parsePackageVersion("1.0.0")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: null, build: null, raw: "1.0.0" });
    expect(parsePackageVersion("2.1.0-beta.3")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: "beta.3", build: null, raw: "2.1.0-beta.3" });
    expect(parsePackageVersion("2.1.0+build.7")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: null, build: "build.7", raw: "2.1.0+build.7" });
    expect(parsePackageVersion("2.1.0-rc.1+sha.5")).toEqual({ major: 2, minor: 1, patch: 0, prerelease: "rc.1", build: "sha.5", raw: "2.1.0-rc.1+sha.5" });
  });

  it("accepts numbers beyond the installer limits, which are the installer version's concern", () => {
    expect(parsePackageVersion("256.0.0").major).toBe(256);
    expect(parsePackageVersion("0.0.65536").patch).toBe(65536);
  });

  const refused = ["1.0", "1.0.0.0", "01.0.0", "v1.0.0", "1.0.0-", "1.0.0+", "", " 1.0.0", "1.0.0 ", "1.0.-1", "1.a.0", "1.0.0-be ta"];
  it.each(refused)("refuses %j with the contract's message", (raw) => {
    let thrown: unknown;
    try {
      parsePackageVersion(raw);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstallerMetadataError);
    expect((thrown as Error).message).toBe(
      "The package version \"" + raw + "\" is not a valid version (MAJOR.MINOR.PATCH, optionally with -prerelease or +build)."
    );
  });
});

describe("installerVersion", () => {
  it("gives three numbers and no note for a plain version", () => {
    expect(installerVersion(parsePackageVersion("1.0.0"))).toEqual({ version: "1.0.0", note: null });
  });

  it("drops a prerelease with a note", () => {
    expect(installerVersion(parsePackageVersion("2.1.0-beta.3"))).toEqual({
      version: "2.1.0",
      note: "Installer version 2.1.0 (from 2.1.0-beta.3; installer versions hold three numbers, so the prerelease suffix is dropped).",
    });
  });

  it("drops a build with a note", () => {
    expect(installerVersion(parsePackageVersion("2.1.0+build.7"))).toEqual({
      version: "2.1.0",
      note: "Installer version 2.1.0 (from 2.1.0+build.7; installer versions hold three numbers, so the build suffix is dropped).",
    });
  });

  it("drops both with a note naming both", () => {
    expect(installerVersion(parsePackageVersion("2.1.0-rc.1+sha.5"))).toEqual({
      version: "2.1.0",
      note: "Installer version 2.1.0 (from 2.1.0-rc.1+sha.5; installer versions hold three numbers, so the prerelease and build suffix is dropped).",
    });
  });

  it("accepts the largest installer version", () => {
    expect(installerVersion(parsePackageVersion("255.255.65535"))).toEqual({ version: "255.255.65535", note: null });
  });

  const refused: Array<[string, string, number, number]> = [
    ["256.0.0", "major", 256, 255],
    ["0.256.0", "minor", 256, 255],
    ["0.0.65536", "patch", 65536, 65535],
  ];
  it.each(refused)("refuses %s naming the number and the limit", (raw, part, n, limit) => {
    let thrown: unknown;
    try {
      installerVersion(parsePackageVersion(raw));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstallerMetadataError);
    expect((thrown as Error).message).toBe(
      "The package version \"" + raw + "\" cannot be an installer version: the " + part + " number " + n + " is above " + limit + "."
    );
  });
});

describe("checkFolderName", () => {
  const accepted = ["hello", "prödüct", "a&b", "a'b", "東京", "my-game", "console", "COM0", "COM10", "LPT0", "nulx", "a.b", "con sole"];
  it.each(accepted)("accepts %j", (name) => {
    expect(() => checkFolderName(name)).not.toThrow();
  });

  const badCharacters: Array<[string, string]> = [
    ["a<b", "<"],
    ["a:b", ":"],
    ["a\"b", "\""],
    ["a|b", "|"],
    ["a?b", "?"],
    ["a*b", "*"],
    ["a\\b", "\\"],
    ["a/b", "/"],
  ];
  it.each(badCharacters)("refuses %j naming the character", (name, character) => {
    let thrown: unknown;
    try {
      checkFolderName(name);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstallerMetadataError);
    expect((thrown as Error).message).toBe(
      "The product name \"" + name + "\" contains \"" + character + "\", which a Windows folder name cannot contain."
    );
  });

  it("names the first offending character", () => {
    expect(() => checkFolderName("a<b:c")).toThrow(/contains "<"/);
  });

  const other = ["name.", "name ", "a\u0001b", "CON", "con", "Prn", "AUX", "NUL", "nul.txt", "COM1", "com9", "LPT1", "lpt9", "CON.tar.gz", "Aux.x"];
  it.each(other)("refuses %j and names it", (name) => {
    let thrown: unknown;
    try {
      checkFolderName(name);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InstallerMetadataError);
    expect((thrown as Error).message).toContain(name);
  });
});

describe("fileIdentifier", () => {
  function digest(name: string): string {
    return crypto.createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
  }

  it("is the prefix, the sanitized name and the first 8 hex digits of the name's SHA-256", () => {
    expect(fileIdentifier("Cmp", "app.exe")).toBe("Cmp_" + sanitizeId("app.exe") + "_" + digest("app.exe"));
    expect(fileIdentifier("File", "ü&'q.txt")).toBe("File_" + sanitizeId("ü&'q.txt") + "_" + digest("ü&'q.txt"));
  });

  it("keeps a-b.dll and a_b.dll apart", () => {
    expect(fileIdentifier("File", "a-b.dll")).not.toBe(fileIdentifier("File", "a_b.dll"));
    expect(fileIdentifier("Cmp", "a-b.dll")).not.toBe(fileIdentifier("Cmp", "a_b.dll"));
  });

  it("is stable for the same name and differs between the prefixes", () => {
    expect(fileIdentifier("Cmp", "x.dll")).toBe(fileIdentifier("Cmp", "x.dll"));
    expect(fileIdentifier("Cmp", "x.dll")).not.toBe(fileIdentifier("File", "x.dll"));
  });

  it("is at most 72 characters for a 120-character name and still unique per name", () => {
    const first = "a".repeat(116) + ".dll";
    const second = "a".repeat(116) + ".dlx";
    expect(first.length).toBe(120);
    for (const prefix of ["Cmp", "File"] as const) {
      expect(fileIdentifier(prefix, first).length).toBeLessThanOrEqual(72);
      expect(fileIdentifier(prefix, first)).not.toBe(fileIdentifier(prefix, second));
    }
    expect(fileIdentifier("File", first)).toBe("File_" + sanitizeId(first).slice(0, 52) + "_" + digest(first));
  });

  it("gives identifiers that are valid WiX identifiers", () => {
    for (const name of ["a-b.dll", "6-test.exe", "ü&'q.txt", "x<y>.txt", "東京.dll"]) {
      expect(fileIdentifier("File", name)).toMatch(/^[A-Za-z_][A-Za-z0-9_.]*$/);
    }
  });
});
