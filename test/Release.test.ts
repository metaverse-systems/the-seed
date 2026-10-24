/*
 * The releases: version 2.1.0 and the 2.0.0 notes before it, the release notes in CHANGELOG.md, and
 * the places that record them.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - The notes are read from `CHANGELOG.md` at the package root as plain text. The `## 2.0.0`
 *   section runs to the next `## ` heading (or the end); its `###` headings must be exactly the
 *   three groups, in order. The heading line is `## 2.0.0 — YYYY-MM-DD`.
 * - A public subpath counts as named when the notes contain it as a code span (`/Build`) or as a
 *   full import path (`@metaverse-systems/the-seed/Build`).
 * - The exit-status rows are given below as literals (the recorded table of the command-line
 *   consistency release note, plus the two further rows of the notes). A row counts as present when
 *   one table line of the notes has a first cell equal to the condition (whitespace-normalised)
 *   and last two cells equal to the old and new status. The statuses of `EXIT_STATUSES` must all
 *   appear in the line of the notes that states the scheme (the line starting `**Exit statuses.**`).
 * - Each recorded release note is represented by distinctive terms listed as literals with the
 *   source named beside them; a term counts when the notes contain it as written.
 * - The editor extension's manifest is read from the sibling checkout `../the-seed-vscode`; the
 *   case runs only when that checkout is present (`optionalExternalCheck`). It names the tool as an
 *   exact devDependency of this major version, no newer than this package.
 * - A `## X.Y.Z` section runs to the next `## ` heading; the 2.1.0 section must name each interface
 *   it adds as a code span.
 * - Cases that must fail on the tree before the release: version, notes file and everything read
 *   from it, the package file list entry in package.json, the lock files, the README links. The
 *   required-versions case is a guard.
 */
import * as fs from "fs";
import * as path from "path";
import { EXIT_STATUSES } from "../src/cli/ExitStatus";
import { REQUIRED_VERSIONS } from "../src/RequiredVersions";
import { optionalExternalCheck } from "./helpers/ExternalTools";

const packageRoot = path.resolve(__dirname, "..");
const extensionRoot = path.resolve(packageRoot, "..", "the-seed-vscode");
const PACKAGE_NAME = "@metaverse-systems/the-seed";

interface Manifest {
  version: string;
  files?: string[];
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function changelogText(): string {
  const file = path.join(packageRoot, "CHANGELOG.md");
  if (!fs.existsSync(file)) {
    throw new Error("CHANGELOG.md is absent from the package root");
  }
  return fs.readFileSync(file, "utf8");
}

/** The text of the `## <version>` section (2.0.0 when omitted), heading line included. */
function releaseSection(version = "2.0.0"): string {
  const lines = changelogText().split("\n");
  const heading = "## " + version;
  const start = lines.findIndex((line) => line === heading || line.startsWith(heading + " "));
  if (start < 0) {
    throw new Error("CHANGELOG.md has no `" + heading + "` section");
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^## /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The text of one `###` group of the release section. */
function group(title: string): string {
  const lines = releaseSection().split("\n");
  const start = lines.findIndex((line) => line === "### " + title);
  if (start < 0) {
    throw new Error("the 2.0.0 section has no `### " + title + "` heading");
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^### /.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The table lines of the text as arrays of trimmed cells. */
function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.trim().startsWith("|") && line.trim().endsWith("|"))
    .map((line) =>
      line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => normalise(cell)));
}

const HEADINGS = ["Actions required", "Command-line changes", "Library and extension interface changes"];

// The recorded table of the command-line consistency release note ("Release note" of its
// exit-status contract): condition, status before, status now.
const EXIT_STATUS_TABLE: Array<[string, string, string]> = [
  ["no scopes configured (`create-cert`, `import-cert`, `sign`, `export-cert`)", "3", "2"],
  ["no scopes configured (`cert-info`)", "1", "2"],
  ["no certificate (`sign`, `cert-info`, `export-cert`)", "1", "2"],
  ["`import-cert` key mismatch or unsupported key", "3", "2"],
  ["`export-cert` without `--output`", "2", "3"],
  ["`sign` of a directory with no binary files", "4", "1"],
  ["`build` usage errors", "1", "3"],
  ["native component missing", "1", "2"],
  ["configuration error", "1", "2"],
  ["`installer windows` unknown `--scope`; `wixl` missing", "1", "2"],
  [
    "`installer windows` with no or an unreadable `package.json`, or a package version or product name it refuses",
    "1",
    "2",
  ],
  ["`signing sign` of a path that does not exist", "3", "2"],
  ["`signing sign` of a file that is not binary or is read-only, or another signing failure", "3", "1"],
  [
    "`package` without a project directory; `dependencies check` or `install` with an unknown target",
    "1",
    "3",
  ],
  ["`resource-pak add` or `build` outside a pak project (no readable `package.json`)", "uncaught stack trace", "2"],
  ["`package` with a project directory that does not exist", "1", "2"],
  ["unknown command or subcommand; `dependencies` with an unknown subcommand", "0", "3"],
  ["`dependencies install` failure", "0", "1"],
];

// The two further rows of the notes: a key word of the condition, status before, status now.
const EXTRA_ROWS: Array<[RegExp, string, string]> = [
  [/signing verify.*untrusted/i, "0", "4"],
  [/configuration file.*cannot be read/i, "stack trace", "2"],
];

// Distinctive terms of each recorded release note, named by source.
const RECORDED_TERMS: Array<[string, string[]]> = [
  // Dependency discovery and packaging: its package-command release note.
  ["package command", ["libgreet.so.0", "file:", "getPackageDeps"]],
  // Tool installation: its lifecycle release note.
  ["tool installation", ["npm run build-addon", "PKG_CONFIG_PATH"]],
  // Command-line consistency: its exit-status release note, "Other visible changes".
  [
    "command-line consistency",
    [
      "config scopes",
      "scopes list",
      "There are no scopes to delete",
      "THE_SEED_DEBUG",
      "hello-1.0.0.msi",
      "hello-1.0.0.0.msi",
      "--validity-days",
    ],
  ],
  // Templates and resource paks: its release notes contract.
  ["templates and resource paks", ["--force", "--attribute", "foreign", "ProjectError", "PackageAuthorType"]],
];

// Interface names recorded by the earlier changes and by this one, the later changes' notes among them.
const INTERFACE_TERMS = [
  "the_seed_native",
  "machoListSlices",
  "peStripSignature",
  "readResourcePak",
  "removeEmbeddedSignature",
  "buildProject",
  "getRecursiveBuildSteps",
  "certificate-missing",
  "UnsupportedSigningKey",
  "loadTrust",
  "SigningError",
  "NativeComponentMissingError",
  "runCli",
  "ScriptArgsType",
  "ConfigError",
  "BuildStep",
  "--jobs",
  "--cert",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "@types/node",
  "ts-jest",
  "node-addon-api",
];

/** The three numbers of an exact `X.Y.Z` version, or null for anything else. */
function exactVersion(text: string | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text ?? "");
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) {
      return a[index] - b[index];
    }
  }
  return 0;
}

// The interfaces 2.1.0 adds, each named in its notes as a code span.
const RELEASE_2_1_0_NAMES = [
  "PackageRunOptions",
  "InstallerRunOptions",
  "PackageCopyEvent",
  "ToolLog",
  "ToolLogLevel",
  "runInstallSteps",
  "InstallStepsOptions",
  "InstallStepsResult",
];

describe("release 2.1.0", () => {
  test("package.json and package-lock.json state version 2.1.0", () => {
    const manifest = readJson<Manifest>(path.join(packageRoot, "package.json"));
    expect(manifest.version).toBe("2.1.0");
    const lock = readJson<{ version: string; packages: Record<string, { version: string }> }>(
      path.join(packageRoot, "package-lock.json"));
    expect(lock.version).toBe("2.1.0");
    expect(lock.packages[""].version).toBe("2.1.0");
  });

  test("CHANGELOG.md has a dated 2.1.0 heading above the 2.0.0 heading", () => {
    const lines = changelogText().split("\n");
    const newer = lines.findIndex((line) => /^## 2\.1\.0 — \d{4}-\d{2}-\d{2}$/.test(line));
    const older = lines.findIndex((line) => /^## 2\.0\.0(\s|$)/.test(line));
    expect(newer).toBeGreaterThanOrEqual(0);
    expect(older).toBeGreaterThan(newer);
    const firstRelease = lines.findIndex((line) => /^## /.test(line));
    expect(firstRelease).toBe(newer);
  });

  test("the 2.1.0 section has exactly the three groups, in order", () => {
    const headings = releaseSection("2.1.0")
      .split("\n")
      .filter((line) => /^###\s/.test(line))
      .map((line) => line.replace(/^###\s+/, ""));
    expect(headings).toEqual(HEADINGS);
  });

  test("the 2.1.0 section names every interface it adds as a code span", () => {
    const text = releaseSection("2.1.0");
    expect(RELEASE_2_1_0_NAMES.filter((name) => !text.includes("`" + name + "`"))).toEqual([]);
  });
});

describe("release 2.0.0", () => {
  test("the 2.0.0 section is still present", () => {
    expect(changelogText().split("\n").some((line) => /^## 2\.0\.0 — \d{4}-\d{2}-\d{2}$/.test(line))).toBe(true);
  });

  test("the required library versions are unchanged", () => {
    expect(REQUIRED_VERSIONS["ecs-cpp"]).toBe("2.1.0");
    expect(REQUIRED_VERSIONS["the-seed"]).toBe("0.8.0");
  });

  test("CHANGELOG.md is listed in the package files and linked from the README", () => {
    const manifest = readJson<Manifest>(path.join(packageRoot, "package.json"));
    expect(manifest.files).toContain("CHANGELOG.md");
    const readme = fs.readFileSync(path.join(packageRoot, "README.md"), "utf8");
    const lines = readme.split("\n");
    const linked = lines
      .map((line, index) => ({ line, number: index + 1 }))
      .filter((entry) => /\]\((\.\/)?CHANGELOG\.md\)/.test(entry.line));
    expect(linked.length).toBeGreaterThanOrEqual(2);
    expect(linked[0].number).toBeLessThanOrEqual(30);
    const apiHeading = lines.findIndex((line) => /^#+ API/.test(line)) + 1;
    expect(apiHeading).toBeGreaterThan(0);
    expect(linked.some((entry) => entry.number > apiHeading)).toBe(true);
  });

  test("the editor extension names the tool as an exact devDependency of this major version, no newer than this package", () => {
    const extensionManifest = path.join(extensionRoot, "package.json");
    if (!optionalExternalCheck("the-seed-vscode", fs.existsSync(extensionManifest), "the editor extension checkout is absent")) {
      return;
    }
    const manifest = readJson<Manifest>(path.join(packageRoot, "package.json"));
    const extension = readJson<Manifest>(extensionManifest);
    const own = exactVersion(manifest.version);
    const wanted = exactVersion(extension.devDependencies?.[PACKAGE_NAME]);
    expect(own).not.toBeNull();
    expect(wanted).not.toBeNull();
    if (own === null || wanted === null) {
      return;
    }
    expect(wanted[0]).toBe(own[0]);
    expect(compareVersions(wanted, own)).toBeLessThanOrEqual(0);
    expect(extension.dependencies?.[PACKAGE_NAME]).toBeUndefined();
  });
});

describe("CHANGELOG.md", () => {
  test("starts with the title, the earlier-versions line and a dated 2.0.0 heading", () => {
    const lines = changelogText().split("\n");
    expect(lines[0]).toBe("# Changes");
    expect(lines).toContain("Versions before 2.0.0 have no release notes.");
    expect(lines.some((line) => /^## 2\.0\.0 — \d{4}-\d{2}-\d{2}$/.test(line))).toBe(true);
  });

  test("the 2.0.0 section has exactly the three groups, in order", () => {
    const headings = releaseSection()
      .split("\n")
      .filter((line) => /^###\s/.test(line))
      .map((line) => line.replace(/^###\s+/, ""));
    expect(headings).toEqual(HEADINGS);
  });

  test("the opening paragraph states the required library versions", () => {
    const section = releaseSection();
    expect(section).toContain("libecs-cpp " + REQUIRED_VERSIONS["ecs-cpp"]);
    expect(section).toContain("libthe-seed " + REQUIRED_VERSIONS["the-seed"]);
  });

  test("it names the native component", () => {
    expect(releaseSection()).toContain("the_seed_native");
  });

  test("it names the package entry point and every public subpath of exports", () => {
    const manifest = readJson<Manifest>(path.join(packageRoot, "package.json"));
    const keys = Object.keys(manifest.exports ?? {});
    const subpaths = keys.filter((key) => key !== "." && key !== "./package.json").map((key) => key.slice(1));
    expect(subpaths.length).toBeGreaterThan(0);
    const text = group("Library and extension interface changes");
    expect(text).toContain(PACKAGE_NAME);
    const missing = subpaths.filter(
      (subpath) => !text.includes("`" + subpath + "`") && !text.includes(PACKAGE_NAME + subpath));
    expect(missing).toEqual([]);
  });

  test("the exit-status scheme line names every status of the scheme", () => {
    const line = group("Command-line changes")
      .split("\n")
      .find((entry) => entry.startsWith("**Exit statuses.**"));
    expect(line).toBeDefined();
    const missing = EXIT_STATUSES.map((row) => row.status).filter((status) => !(line ?? "").includes(status));
    expect(missing).toEqual([]);
  });

  test("the Was / Now table has every recorded row with its old and new status", () => {
    const rows = tableRows(group("Command-line changes"));
    const missing: string[] = [];
    for (const [condition, was, now] of EXIT_STATUS_TABLE) {
      const found = rows.some(
        (cells) => cells.length >= 3 && cells[0] === condition && cells[cells.length - 2] === was
          && cells[cells.length - 1] === now);
      if (!found) {
        missing.push(condition + " | " + was + " | " + now);
      }
    }
    expect(missing).toEqual([]);
  });

  test("the table has the two further rows", () => {
    const rows = tableRows(group("Command-line changes"));
    const missing: string[] = [];
    for (const [condition, was, now] of EXTRA_ROWS) {
      const found = rows.some(
        (cells) => cells.length >= 3 && condition.test(cells[0]) && cells[cells.length - 2] === was
          && cells[cells.length - 1] === now);
      if (!found) {
        missing.push(String(condition) + " | " + was + " | " + now);
      }
    }
    expect(missing).toEqual([]);
  });

  test.each(RECORDED_TERMS)("it carries the distinctive terms of the %s release note", (_source, terms) => {
    const text = releaseSection();
    expect(terms.filter((term) => !text.includes(term))).toEqual([]);
  });

  test("it names the interfaces recorded by the earlier changes and this one", () => {
    const text = releaseSection();
    expect(INTERFACE_TERMS.filter((term) => !text.includes(term))).toEqual([]);
  });

  test("it contains no task number or spec reference", () => {
    const pattern = /speckit|\bspec(s)? 0[4-9][0-9]\b|\btasks? [0-9]+\b|\[0[4-9][0-9]\]/i;
    const offending = changelogText()
      .split("\n")
      .filter((line) => pattern.test(line));
    expect(offending).toEqual([]);
  });
});
