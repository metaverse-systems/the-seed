import fs from "fs";
import crypto from "crypto";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import * as runChecks from "../scripts/run-checks";
import { KnownGapEntry, runKnownGap, itKnownGap, staleMessage } from "./helpers/KnownGap";
import { expectPresent } from "./helpers/Assert";
import { makeUniversal } from "./helpers/Universal";
import Signing from "../src/Signing";
import { readSignedData } from "../src/CmsReader";
import { checkMachO, sliceSignatureBlobs } from "./helpers/MachOChecker";
import { toolEnv } from "./helpers/IndependentCheck";
import { toolEnv as nativeToolEnv } from "./helpers/NativeTree";
import { elfImage } from "./helpers/ElfImage";
import { withoutNativeComponent, nativeComponentPath, fileDigest } from "./helpers/NativeAbsent";
import { writeProject, linkModule, readBound, onRead } from "./helpers/ScratchProjects";
import { readWxs } from "./helpers/WxsReader";
import { snapshotTree } from "./helpers/RunCli";

// Expected shapes of the runner's pure functions, as exercised here:
//   summariseResults(jest, entries) -> { lines: string[], failed: boolean }
//   validateKnownGaps(entries, calls, documents) -> { errors: string[], notices: string[] }
//     calls: { id, title }[] found in test/*.ts; documents: null or { review, roadmap } (file text)
//   validateKnownGapFiles(packageRoot) -> { errors, notices }, reading test/known-gaps.json,
//     test/*.ts and the parent documents (../docs/reviews/the-seed-1.md, ../docs/roadmaps/the-seed-1.md)
// Errors carry only the detail; the runner adds the "MALFORMED KNOWN GAP: " prefix when printing.

const packageRoot = path.resolve(__dirname, "..");
const TAG = (finding: number) => ` [known gap: the-seed-1 finding ${finding}]`;

function rel(...parts: string[]): string {
  return path.join(packageRoot, ...parts);
}

interface AssertionResult {
  fullName: string;
  title: string;
  status: string;
}

function group(file: string, status: string, assertions: AssertionResult[], message = ""): Record<string, unknown> {
  return { name: rel("test", file), status, message, assertionResults: assertions };
}

function assertion(fullName: string, status: string): AssertionResult {
  return { fullName, title: fullName, status };
}

function entry(overrides: Partial<KnownGapEntry> = {}): KnownGapEntry {
  return {
    id: "resource-pak-fresh-prefix",
    review: "the-seed-1",
    finding: 5,
    fixedBy: "First use and plain builds",
    signature: "no such file or directory, mkdir",
    reason: "createPackage creates a directory without creating its parent first",
    cases: ["ResourcePak should create a new package", "ResourcePak should save package configuration"],
    ...overrides,
  };
}

const goodCalls = [
  { id: "resource-pak-fresh-prefix", title: "should create a new package" },
  { id: "resource-pak-fresh-prefix", title: "should save package configuration" },
];

const goodReview = "# Review\n\n### 4. Something else\n\n### 5. Fresh prefix fails\n\ntext\n";
const goodRoadmap = [
  "| Order | Findings | Notes |",
  "|---|---|---|",
  "| 3. First use and plain builds | 5, 6 | first |",
  "",
  "**Task 3 — First use and plain builds**",
  "",
].join("\n");

describe("summariseResults", () => {
  const entries = [entry()];

  function jest(groups: Record<string, unknown>[], success = true): Record<string, unknown> {
    return { success, testResults: groups };
  }

  it("counts passed, failed, known gaps and skipped cases", () => {
    const result = runChecks.summariseResults(
      jest([
        group("A.test.ts", "failed", [
          assertion("A one", "passed"),
          assertion("A two", "failed"),
          assertion("A three", "pending"),
          assertion("A four", "todo"),
          assertion("A five", "passed"),
        ]),
        group("B.test.ts", "passed", [
          assertion("B gap" + TAG(5), "passed"),
          assertion("B ok", "passed"),
        ]),
      ], false),
      entries,
    );
    expect(result.lines[result.lines.length - 1]).toBe("Totals: 3 passed, 1 failed, 1 known gaps, 2 skipped, 2 groups (1 failed)");
    expect(result.failed).toBe(true);
  });

  it("names a failed case with its relative file and full name", () => {
    const result = runChecks.summariseResults(
      jest([group("A.test.ts", "failed", [assertion("A two", "failed")])], false),
      entries,
    );
    expect(result.lines).toContain("FAILED: " + path.join("test", "A.test.ts") + " › A two");
  });

  it("names a failed group that has no case results with the first line of its message", () => {
    const result = runChecks.summariseResults(
      jest([group("C.test.ts", "failed", [], "Test suite failed to run\n\nsecond line")], false),
      entries,
    );
    expect(result.lines).toContain("FAILED GROUP: " + path.join("test", "C.test.ts") + ": Test suite failed to run");
    expect(result.lines[result.lines.length - 1]).toBe("Totals: 0 passed, 0 failed, 0 known gaps, 0 skipped, 1 groups (1 failed)");
    expect(result.failed).toBe(true);
  });

  it("names a failed group whose cases all passed (a hook failed) and fails the run", () => {
    const result = runChecks.summariseResults(
      jest([group("D.test.ts", "failed", [assertion("D one", "passed")], "afterAll hook failed\nmore")], false),
      entries,
    );
    expect(result.lines).toContain("FAILED GROUP: " + path.join("test", "D.test.ts") + ": afterAll hook failed");
    expect(result.lines[result.lines.length - 1]).toBe("Totals: 1 passed, 0 failed, 0 known gaps, 0 skipped, 1 groups (1 failed)");
    expect(result.failed).toBe(true);
  });

  it("does not name a failed group again when one of its cases is named", () => {
    const result = runChecks.summariseResults(
      jest([group("E.test.ts", "failed", [assertion("E one", "failed")], "1 test failed")], false),
      entries,
    );
    expect(result.lines.filter((line) => line.startsWith("FAILED GROUP:"))).toEqual([]);
  });

  it("reports a known gap without its tag and with the fixing task looked up from the entries", () => {
    const result = runChecks.summariseResults(
      jest([group("B.test.ts", "passed", [assertion("ResourcePak should create a new package" + TAG(5), "passed")])]),
      entries,
    );
    expect(result.lines).toContain(
      "KNOWN GAP: " + path.join("test", "B.test.ts") +
        " › ResourcePak should create a new package (the-seed-1 finding 5; fixed by the-seed-1: First use and plain builds)",
    );
    expect(result.lines[result.lines.length - 1]).toBe("Totals: 0 passed, 0 failed, 1 known gaps, 0 skipped, 1 groups (0 failed)");
    expect(result.failed).toBe(false);
  });

  it("prints lines in the order failed groups, failed cases, known gaps, totals", () => {
    const result = runChecks.summariseResults(
      jest([
        group("B.test.ts", "passed", [assertion("B gap" + TAG(5), "passed")]),
        group("A.test.ts", "failed", [assertion("A two", "failed")]),
        group("C.test.ts", "failed", [], "boom"),
      ], false),
      entries,
    );
    const prefixes = ["FAILED GROUP: ", "FAILED: ", "KNOWN GAP: ", "Totals: "];
    const order = prefixes.map((prefix) => result.lines.findIndex((line: string) => line.startsWith(prefix)));
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it("passes when Jest succeeded and no group failed", () => {
    const result = runChecks.summariseResults(
      jest([group("A.test.ts", "passed", [assertion("A one", "passed")])]),
      entries,
    );
    expect(result.failed).toBe(false);
    expect(result.lines).toEqual(["Totals: 1 passed, 0 failed, 0 known gaps, 0 skipped, 1 groups (0 failed)"]);
  });

  it("reports failure when Jest success is false even if every case passed", () => {
    const result = runChecks.summariseResults(
      jest([group("A.test.ts", "passed", [assertion("A one", "passed")])], false),
      entries,
    );
    expect(result.failed).toBe(true);
  });
});

describe("parseArguments", () => {
  it("runs all three stages in order when no stage is named", () => {
    expect(runChecks.parseArguments([])).toEqual({ error: null, stages: ["typecheck", "lint", "unit"], jestArgs: [] });
  });

  it("orders the named stages and passes the rest to Jest", () => {
    const parsed = runChecks.parseArguments(["unit", "lint", "-t", "ResourcePak"]);
    expect(parsed.stages).toEqual(["lint", "unit"]);
    expect(parsed.jestArgs).toEqual(["-t", "ResourcePak"]);
  });

  it("treats a leading word that is neither a stage nor a path as an unknown stage", () => {
    expect(runChecks.parseArguments(["bogus"]).error).toBe("bogus");
  });

  it("passes options and existing paths on to Jest when no stage is named", () => {
    expect(runChecks.parseArguments(["--bail"]).jestArgs).toEqual(["--bail"]);
    expect(runChecks.parseArguments(["test"]).error).toBeNull();
  });
});

describe("install stage selection", () => {
  type StageOutcome = { stage: string; passed: boolean };
  const summariseStages = (outcomes: StageOutcome[]): string =>
    (runChecks as unknown as { summariseStages: (outcomes: StageOutcome[]) => string }).summariseStages(outcomes);

  it("selects only the install stage when it is named alone", () => {
    expect(runChecks.parseArguments(["install"])).toEqual({ error: null, stages: ["install"], jestArgs: [] });
  });

  it("keeps install out of the default set", () => {
    expect(runChecks.parseArguments([]).stages).toEqual(["typecheck", "lint", "unit"]);
    expect(runChecks.STAGES).toContain("install");
  });

  it("keeps the runner's stage order when install is named with another stage", () => {
    expect(runChecks.parseArguments(["unit", "install"]).stages).toEqual(["unit", "install"]);
    expect(runChecks.parseArguments(["install", "lint"]).stages).toEqual(["lint", "install"]);
  });

  it("includes install PASS or FAIL in the summary only when the stage ran", () => {
    const withoutInstall = summariseStages([
      { stage: "typecheck", passed: true },
      { stage: "lint", passed: true },
      { stage: "unit", passed: true },
    ]);
    expect(withoutInstall).not.toContain("install");
    expect(summariseStages([{ stage: "unit", passed: true }, { stage: "install", passed: true }])).toContain("install PASS");
    expect(summariseStages([{ stage: "unit", passed: true }, { stage: "install", passed: false }])).toContain("install FAIL");
  });
});

describe("validateKnownGaps", () => {
  let base: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "known-gaps-"));
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function validate(entries: unknown, calls = goodCalls, documents: { review: string; roadmap: string } | null = {
    review: goodReview,
    roadmap: goodRoadmap,
  }) {
    return runChecks.validateKnownGaps(entries, calls, documents);
  }

  function writePackage(files: Record<string, string>, withDocuments: boolean): string {
    const root = path.join(base, "the-seed");
    fs.mkdirSync(path.join(root, "test"), { recursive: true });
    for (const name of Object.keys(files)) {
      fs.writeFileSync(path.join(root, "test", name), files[name]);
    }
    if (withDocuments) {
      fs.mkdirSync(path.join(base, "docs", "reviews"), { recursive: true });
      fs.mkdirSync(path.join(base, "docs", "roadmaps"), { recursive: true });
      fs.writeFileSync(path.join(base, "docs", "reviews", "the-seed-1.md"), goodReview);
      fs.writeFileSync(path.join(base, "docs", "roadmaps", "the-seed-1.md"), goodRoadmap);
    }
    return root;
  }

  const sourceWithCalls = [
    "describe(\"ResourcePak\", () => {",
    "  itKnownGap(\"resource-pak-fresh-prefix\", \"should create a new package\", () => {});",
    "  itKnownGap(\"resource-pak-fresh-prefix\", \"should save package configuration\", () => {});",
    "});",
  ].join("\n");

  it("accepts a well-formed list", () => {
    const result = validate([entry()]);
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it("accepts an empty list", () => {
    expect(validate([], []).errors).toEqual([]);
  });

  it("reports a missing file", () => {
    const root = writePackage({}, true);
    const result = runChecks.validateKnownGapFiles(root);
    expect(result.errors.join("\n")).toMatch(/known-gaps\.json/);
    expect(result.errors.join("\n")).toMatch(/missing|not found|does not exist/i);
  });

  it("reports invalid JSON", () => {
    const root = writePackage({ "known-gaps.json": "{ not json" }, true);
    const result = runChecks.validateKnownGapFiles(root);
    expect(result.errors.join("\n")).toMatch(/not valid JSON/i);
  });

  it("reports a file that is not an array", () => {
    const root = writePackage({ "known-gaps.json": "{}" }, true);
    const result = runChecks.validateKnownGapFiles(root);
    expect(result.errors.join("\n")).toMatch(/array/i);
    expect(validate({}).errors.join("\n")).toMatch(/array/i);
  });

  it("reads the list, the itKnownGap calls and the parent documents from disk", () => {
    const root = writePackage({
      "known-gaps.json": JSON.stringify([entry()]),
      "ResourcePak.test.ts": sourceWithCalls,
    }, true);
    const result = runChecks.validateKnownGapFiles(root);
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([]);
  });

  it("reports a problem found on disk with the documents present", () => {
    const root = writePackage({
      "known-gaps.json": JSON.stringify([entry({ fixedBy: "" })]),
      "ResourcePak.test.ts": sourceWithCalls,
    }, true);
    expect(runChecks.validateKnownGapFiles(root).errors.join("\n")).toMatch(/fixedBy/);
  });

  describe("field rules", () => {
    it("rejects an id that is not lower-case letters, digits and hyphens", () => {
      const result = validate([entry({ id: "Bad_Id" })], [{ id: "Bad_Id", title: "should create a new package" }, { id: "Bad_Id", title: "should save package configuration" }]);
      expect(result.errors.join("\n")).toMatch(/id/);
      expect(result.errors.join("\n")).toMatch(/Bad_Id/);
    });

    it("rejects a duplicate id", () => {
      const second = entry({ cases: ["Other case"] });
      const result = validate([entry(), second], goodCalls.concat([{ id: "resource-pak-fresh-prefix", title: "case" }]));
      expect(result.errors.join("\n")).toMatch(/duplicate|unique/i);
    });

    it("rejects a review other than the-seed-1", () => {
      expect(validate([entry({ review: "the-seed-2" })]).errors.join("\n")).toMatch(/review/);
    });

    it("rejects a finding that is not an integer from 1 to 17", () => {
      for (const finding of [0, 18, 2.5, "5"]) {
        const result = validate([entry({ finding: finding as unknown as number })]);
        expect(result.errors.join("\n")).toMatch(/finding/);
      }
    });

    it("rejects an empty fixedBy", () => {
      expect(validate([entry({ fixedBy: "" })]).errors.join("\n")).toMatch(/fixedBy/);
    });

    it("rejects an empty reason", () => {
      expect(validate([entry({ reason: "" })]).errors.join("\n")).toMatch(/reason/);
    });

    it("rejects a signature shorter than 12 characters", () => {
      expect(validate([entry({ signature: "short" })]).errors.join("\n")).toMatch(/signature/);
    });

    it("rejects a signature that is only a generic word", () => {
      for (const signature of ["Error", "expect", "failed", "            "]) {
        expect(validate([entry({ signature })]).errors.join("\n")).toMatch(/signature/);
      }
    });

    it("rejects an empty cases list", () => {
      expect(validate([entry({ cases: [] })], []).errors.join("\n")).toMatch(/cases/);
    });

    it("rejects a case name listed twice across the file", () => {
      const other = entry({ id: "other-gap", cases: ["ResourcePak should create a new package"] });
      const calls = goodCalls.concat([{ id: "other-gap", title: "should create a new package" }]);
      expect(validate([entry(), other], calls).errors.join("\n")).toMatch(/duplicate|unique|more than once/i);
    });
  });

  describe("itKnownGap calls", () => {
    it("rejects a call whose id is not in the list", () => {
      const calls = goodCalls.concat([{ id: "unlisted-gap", title: "should do something" }]);
      const result = validate([entry()], calls);
      expect(result.errors.join("\n")).toMatch(/unlisted-gap/);
    });

    it("rejects cases that do not match the calls one-to-one", () => {
      const missingCall = validate([entry()], goodCalls.slice(0, 1));
      expect(missingCall.errors.join("\n")).toMatch(/resource-pak-fresh-prefix/);
      const extraCall = validate([entry()], goodCalls.concat([{ id: "resource-pak-fresh-prefix", title: "should do more" }]));
      expect(extraCall.errors.join("\n")).toMatch(/resource-pak-fresh-prefix/);
    });

    it("rejects an entry that has no calls", () => {
      const result = validate([entry()], []);
      expect(result.errors.join("\n")).toMatch(/resource-pak-fresh-prefix/);
    });
  });

  describe("parent documents", () => {
    it("rejects a finding with no heading in the review", () => {
      const result = validate([entry({ finding: 7 })], goodCalls, { review: goodReview, roadmap: goodRoadmap });
      expect(result.errors.join("\n")).toMatch(/### 7\.|finding 7/);
    });

    it("rejects a fixedBy with no task in the roadmap", () => {
      const result = validate([entry({ fixedBy: "Unknown task" })], goodCalls, { review: goodReview, roadmap: goodRoadmap });
      expect(result.errors.join("\n")).toMatch(/Unknown task/);
    });

    it("rejects a finding that is not in the order-table row of the task", () => {
      const roadmap = goodRoadmap.replace("| 5, 6 |", "| 6, 7 |");
      const result = validate([entry()], goodCalls, { review: goodReview, roadmap });
      expect(result.errors.join("\n")).toMatch(/First use and plain builds/);
      expect(result.errors.join("\n")).toMatch(/5/);
    });

    it("prints a notice and no error when the documents are absent", () => {
      const result = validate([entry({ finding: 7 })], goodCalls, null);
      expect(result.errors).toEqual([]);
      expect(result.notices).toEqual(["Known-gap references not checked against the review: the parent repository is not present."]);
    });

    it("prints the notice from disk when the documents are absent", () => {
      const root = writePackage({
        "known-gaps.json": JSON.stringify([entry()]),
        "ResourcePak.test.ts": sourceWithCalls,
      }, false);
      const result = runChecks.validateKnownGapFiles(root);
      expect(result.errors).toEqual([]);
      expect(result.notices).toEqual(["Known-gap references not checked against the review: the parent repository is not present."]);
    });
  });
});

describe("runKnownGap", () => {
  const gapEntry = entry();

  it("classifies a synchronous throw containing the signature as a gap", async () => {
    const outcome = await runKnownGap(gapEntry, () => {
      throw new Error("ENOENT: no such file or directory, mkdir '/x/projects/@test'");
    });
    expect(outcome).toEqual({ kind: "gap" });
  });

  it("classifies an async rejection containing the signature as a gap", async () => {
    const outcome = await runKnownGap(gapEntry, async () => {
      throw new Error("ENOENT: no such file or directory, mkdir '/x'");
    });
    expect(outcome).toEqual({ kind: "gap" });
  });

  it("classifies a different error as other and carries the original error", async () => {
    const original = new Error("expected 1 to be 2");
    const outcome = await runKnownGap(gapEntry, () => {
      throw original;
    });
    expect(outcome.kind).toBe("other");
    expect((outcome as { kind: "other"; error: unknown }).error).toBe(original);
  });

  it("classifies a completing function as stale", async () => {
    expect(await runKnownGap(gapEntry, () => undefined)).toEqual({ kind: "stale" });
    expect(await runKnownGap(gapEntry, async () => 1)).toEqual({ kind: "stale" });
  });

  it("produces the stale message naming the entry, finding, task and case", () => {
    expect(staleMessage(gapEntry, "should create a new package")).toBe(
      "STALE KNOWN GAP: resource-pak-fresh-prefix (the-seed-1 finding 5, fixed by \"First use and plain builds\"): " +
        "\"should create a new package\" now passes; remove the itKnownGap marker and the entry from test/known-gaps.json",
    );
  });

  it("makes itKnownGap throw for an id that is not in the list", () => {
    expect(() => itKnownGap("no-such-gap", "does not matter", () => undefined)).toThrow(
      "MALFORMED KNOWN GAP: unknown id \"no-such-gap\"",
    );
  });
});

describe("expectPresent", () => {
  it("returns a present value unchanged, including falsy ones", () => {
    const object = { a: 1 };
    expect(expectPresent(object, "object")).toBe(object);
    expect(expectPresent(0, "number")).toBe(0);
    expect(expectPresent("", "text")).toBe("");
    expect(expectPresent(false, "flag")).toBe(false);
  });

  it("fails with \"<what> is missing\" for null", () => {
    expect(() => expectPresent(null, "signaturePath")).toThrow("signaturePath is missing");
  });

  it("fails with \"<what> is missing\" for undefined", () => {
    expect(() => expectPresent(undefined, "signer")).toThrow("signer is missing");
  });
});

// Expected shapes of the runner's scratch-area and real-home functions, as exercised here:
//   findLeftovers(scratchRoot) -> string[]   paths under scratchRoot (normally holding home/ and tmp/),
//     relative to it, with forward slashes, for every file or directory found (nested ones included)
//   snapshotRealHome(home) -> opaque value   describes <home>/the-seed/config.json and the entries
//     directly inside <home>/the-seed; "absent" parts are allowed
//   compareRealHome(before, after) -> string[]   one "<entry>: <before> -> <after>" line per difference,
//     where a missing side is written "absent"; empty when equal
describe("scratch area and real-home checks", () => {
  let roots: string[] = [];

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "the-seed-infra-scratch-"));
    roots.push(root);
    return root;
  }

  function makeHome(): string {
    const home = makeRoot();
    fs.mkdirSync(path.join(home, "the-seed"));
    return home;
  }

  afterEach(() => {
    for (const root of roots) {
      fs.rmSync(root, { recursive: true, force: true });
    }
    roots = [];
  });

  describe("findLeftovers", () => {
    it("reports nothing for empty home and tmp directories", () => {
      const root = makeRoot();
      fs.mkdirSync(path.join(root, "home"));
      fs.mkdirSync(path.join(root, "tmp"));
      expect(runChecks.findLeftovers(root)).toEqual([]);
    });

    it("reports nested files and directories relative to the scratch root", () => {
      const root = makeRoot();
      fs.mkdirSync(path.join(root, "home", ".config", "the-seed"), { recursive: true });
      fs.mkdirSync(path.join(root, "tmp", "build-1"), { recursive: true });
      fs.writeFileSync(path.join(root, "home", "x"), "x");
      fs.writeFileSync(path.join(root, "tmp", "build-1", "out.txt"), "y");

      const leftovers: string[] = runChecks.findLeftovers(root).map((p: string) => p.split(path.sep).join("/"));
      expect(leftovers).toEqual(
        expect.arrayContaining(["home/x", "home/.config", "home/.config/the-seed", "tmp/build-1", "tmp/build-1/out.txt"]),
      );
      expect(leftovers).toHaveLength(5);
    });
  });

  describe("snapshotRealHome and compareRealHome", () => {
    it("treats an absent the-seed directory before and after as equal", () => {
      const home = makeRoot();
      const before = runChecks.snapshotRealHome(home);
      const after = runChecks.snapshotRealHome(home);
      expect(runChecks.compareRealHome(before, after)).toEqual([]);
    });

    it("treats an unchanged the-seed directory as equal", () => {
      const home = makeHome();
      fs.writeFileSync(path.join(home, "the-seed", "config.json"), "{}");
      fs.mkdirSync(path.join(home, "the-seed", "projects"));
      const before = runChecks.snapshotRealHome(home);
      const after = runChecks.snapshotRealHome(home);
      expect(runChecks.compareRealHome(before, after)).toEqual([]);
    });

    it("reports a changed config.json hash", () => {
      const home = makeHome();
      const config = path.join(home, "the-seed", "config.json");
      fs.writeFileSync(config, "{\"a\":1}");
      const before = runChecks.snapshotRealHome(home);
      fs.writeFileSync(config, "{\"a\":2}");
      const after = runChecks.snapshotRealHome(home);

      const differences: string[] = runChecks.compareRealHome(before, after);
      expect(differences.length).toBeGreaterThan(0);
      expect(differences.some((d) => d.startsWith("config.json: ") && d.includes(" -> "))).toBe(true);
    });

    it("reports an added entry as <entry>: absent -> <after>", () => {
      const home = makeHome();
      const before = runChecks.snapshotRealHome(home);
      fs.writeFileSync(path.join(home, "the-seed", "added.txt"), "x");
      const after = runChecks.snapshotRealHome(home);

      const differences: string[] = runChecks.compareRealHome(before, after);
      expect(differences).toHaveLength(1);
      expect(differences[0]).toMatch(/^added\.txt: absent -> .+/);
    });

    it("reports a removed entry as <entry>: <before> -> absent", () => {
      const home = makeHome();
      fs.writeFileSync(path.join(home, "the-seed", "gone.txt"), "x");
      const before = runChecks.snapshotRealHome(home);
      fs.rmSync(path.join(home, "the-seed", "gone.txt"));
      const after = runChecks.snapshotRealHome(home);

      const differences: string[] = runChecks.compareRealHome(before, after);
      expect(differences).toHaveLength(1);
      expect(differences[0]).toMatch(/^gone\.txt: .+ -> absent$/);
    });

    it("reports an entry whose modification time changed", () => {
      const home = makeHome();
      const file = path.join(home, "the-seed", "touched.txt");
      fs.writeFileSync(file, "x");
      fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
      const before = runChecks.snapshotRealHome(home);
      fs.utimesSync(file, new Date(2021, 5, 6), new Date(2021, 5, 6));
      const after = runChecks.snapshotRealHome(home);

      const differences: string[] = runChecks.compareRealHome(before, after);
      expect(differences).toHaveLength(1);
      expect(differences[0]).toMatch(/^touched\.txt: .+ -> .+/);
    });

    it("reports a the-seed directory that appeared", () => {
      const home = makeRoot();
      const before = runChecks.snapshotRealHome(home);
      fs.mkdirSync(path.join(home, "the-seed"));
      fs.writeFileSync(path.join(home, "the-seed", "config.json"), "{}");
      const after = runChecks.snapshotRealHome(home);
      expect(runChecks.compareRealHome(before, after).length).toBeGreaterThan(0);
    });
  });
});

// Expected shape of the external-tool helper, as exercised here:
//   optionalExternalCheck(name, available, reason) -> boolean
//   available: returns true and prints nothing.
//   unavailable, THE_SEED_REQUIRE_TOOLS not "1": returns false and prints "SKIPPED CHECK: <name>: <reason>"
//     once per loaded module (one test file) through console.log, console.warn or console.error.
//   unavailable, THE_SEED_REQUIRE_TOOLS === "1": throws Error("required external tool missing: <name> (<reason>)").
// The helper is loaded with require inside an isolated module registry so that its once-per-file memory
// starts empty in every case, and so that a missing module fails only these cases.
describe("optionalExternalCheck", () => {
  type OptionalExternalCheck = (name: string, available: boolean, reason: string) => boolean;
  const savedEnv = process.env;
  let printed: string[] = [];
  const spies: jest.SpyInstance[] = [];

  function loadHelper(): OptionalExternalCheck {
    let loaded: OptionalExternalCheck | undefined;
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the module is loaded again after jest.isolateModules resets the registry
      loaded = require("./helpers/ExternalTools").optionalExternalCheck;
    });
    return expectPresent(loaded, "optionalExternalCheck");
  }

  beforeEach(() => {
    process.env = { ...savedEnv };
    delete process.env.THE_SEED_REQUIRE_TOOLS;
    printed = [];
    for (const method of ["log", "warn", "error"] as const) {
      spies.push(
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          printed.push(args.map(String).join(" "));
        }),
      );
    }
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) {
      spy.mockRestore();
    }
    process.env = savedEnv;
  });

  it("returns true and prints nothing when the tool is available", () => {
    const check = loadHelper();
    expect(check("python3", true, "not installed")).toBe(true);
    expect(printed).toEqual([]);
  });

  it("returns true and prints nothing when available even if tools are required", () => {
    process.env.THE_SEED_REQUIRE_TOOLS = "1";
    const check = loadHelper();
    expect(check("python3", true, "not installed")).toBe(true);
    expect(printed).toEqual([]);
  });

  it("returns false and prints a SKIPPED CHECK line when unavailable and not required", () => {
    const check = loadHelper();
    expect(check("python3", false, "python3 not found")).toBe(false);
    expect(printed).toEqual(["SKIPPED CHECK: python3: python3 not found"]);
  });

  it("prints the skipped line once per file however often it is called", () => {
    const check = loadHelper();
    expect(check("python3", false, "python3 not found")).toBe(false);
    expect(check("python3", false, "python3 not found")).toBe(false);
    expect(check("python3", false, "python3 not found")).toBe(false);
    expect(printed).toEqual(["SKIPPED CHECK: python3: python3 not found"]);
  });

  it("treats any value other than 1 as not required", () => {
    process.env.THE_SEED_REQUIRE_TOOLS = "0";
    const check = loadHelper();
    expect(check("python3", false, "python3 not found")).toBe(false);
  });

  it("fails with the tool name and reason when unavailable and required", () => {
    process.env.THE_SEED_REQUIRE_TOOLS = "1";
    const check = loadHelper();
    expect(() => check("python3", false, "python3 not found")).toThrow(
      "required external tool missing: python3 (python3 not found)",
    );
    expect(printed).toEqual([]);
  });

  it("fails every time it is called when required", () => {
    process.env.THE_SEED_REQUIRE_TOOLS = "1";
    const check = loadHelper();
    expect(() => check("a", false, "x")).toThrow("required external tool missing: a (x)");
    expect(() => check("a", false, "x")).toThrow("required external tool missing: a (x)");
  });
});

describe("isolated environment", () => {
  it("points the home and temporary locations at the scratch area and disables the Node compile cache", () => {
    const environment = runChecks.isolatedEnvironment({ HOME: "/real", KEEP: "yes" }, "/scratch/home", "/scratch/tmp");
    expect(environment.NODE_DISABLE_COMPILE_CACHE).toBe("1");
    expect(environment.HOME).toBe("/scratch/home");
    expect(environment.TMPDIR).toBe("/scratch/tmp");
    expect(environment.KEEP).toBe("yes");
  });
});

describe("command line", () => {
  const script = rel("scripts", "run-checks.js");
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "run-checks-cli-"));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("exits 2 and lists the stages for an unknown stage name", () => {
    const run = spawnSync(process.execPath, [script, "bogus"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("Unknown stage: bogus. Stages: typecheck, lint, unit");
  });

  it("prints the result lines and totals of an existing results file with --summary and exits 0", () => {
    const file = path.join(directory, "jest.json");
    const results = {
      success: false,
      testResults: [group("F.test.ts", "failed", [assertion("F one", "failed"), assertion("F two", "passed")])],
    };
    fs.writeFileSync(file, JSON.stringify(results));
    const run = spawnSync(process.execPath, [script, "--summary", file], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("FAILED: " + path.join("test", "F.test.ts") + " › F one");
    expect(run.stdout).toContain("Totals: 1 passed, 1 failed, 0 known gaps, 0 skipped, 1 groups (1 failed)");
  });

  it("exits 2 when --summary names no file or an unreadable one", () => {
    expect(spawnSync(process.execPath, [script, "--summary"], { encoding: "utf8" }).status).toBe(2);
    expect(spawnSync(process.execPath, [script, "--summary", path.join(directory, "missing.json")], { encoding: "utf8" }).status).toBe(2);
  });
});

describe("makeUniversal", () => {
  // What these tests fix about the helper: the result is a 32-bit table (magic 0xcafebabe)
  // with one 20-byte entry per slice in the order given (cpu type, cpu subtype, offset, size, align,
  // all big-endian), the first slice at the first multiple of 2^align after the table, each next
  // slice at the next multiple after the previous one, and zero bytes between them.
  const ARM64 = 0x0100000c;
  const X86_64 = 0x01000007;
  const binaries = rel("test", "fixtures", "binaries", "genuine");
  const arm = fs.readFileSync(path.join(binaries, "tiny-macho-arm64"));
  const x86 = fs.readFileSync(path.join(binaries, "tiny-macho-x86_64"));

  function entryOf(table: Buffer, index: number) {
    const at = 8 + index * 20;
    return {
      cpuType: table.readUInt32BE(at),
      cpuSubtype: table.readUInt32BE(at + 4),
      offset: table.readUInt32BE(at + 8),
      size: table.readUInt32BE(at + 12),
      align: table.readUInt32BE(at + 16),
    };
  }

  it("writes a big-endian table with one entry per slice holding its cpu type and subtype", () => {
    const universal = makeUniversal([
      { cpuType: X86_64, cpuSubtype: 3, bytes: x86 },
      { cpuType: ARM64, cpuSubtype: 0, bytes: arm },
    ]);
    expect(universal.readUInt32BE(0)).toBe(0xcafebabe);
    expect(universal.readUInt32BE(4)).toBe(2);
    expect(entryOf(universal, 0)).toMatchObject({ cpuType: X86_64, cpuSubtype: 3, size: x86.length });
    expect(entryOf(universal, 1)).toMatchObject({ cpuType: ARM64, cpuSubtype: 0, size: arm.length });
  });

  it("starts every slice at a multiple of 2^align, defaulting to 14, with the slice bytes unchanged", () => {
    const universal = makeUniversal([
      { cpuType: X86_64, cpuSubtype: 3, bytes: x86 },
      { cpuType: ARM64, cpuSubtype: 0, bytes: arm },
    ]);
    const slices = [x86, arm];
    let previousEnd = 8 + 2 * 20;
    for (let index = 0; index < 2; index++) {
      const entry = entryOf(universal, index);
      expect(entry.align).toBe(14);
      expect(entry.offset % 2 ** 14).toBe(0);
      expect(entry.offset).toBeGreaterThanOrEqual(previousEnd);
      expect(universal.subarray(entry.offset, entry.offset + entry.size).equals(slices[index])).toBe(true);
      previousEnd = entry.offset + entry.size;
    }
    expect(universal.length).toBeGreaterThanOrEqual(previousEnd);
  });

  it("uses the given alignment for the boundaries and records it in each entry", () => {
    const universal = makeUniversal(
      [
        { cpuType: X86_64, cpuSubtype: 3, bytes: x86 },
        { cpuType: ARM64, cpuSubtype: 0, bytes: arm },
      ],
      12,
    );
    for (let index = 0; index < 2; index++) {
      const entry = entryOf(universal, index);
      expect(entry.align).toBe(12);
      expect(entry.offset % 2 ** 12).toBe(0);
    }
  });

  it("assembles programs the independent checker reads with the same per-slice report as the thin files", () => {
    const universal = makeUniversal([
      { cpuType: ARM64, cpuSubtype: 0, bytes: arm },
      { cpuType: X86_64, cpuSubtype: 3, bytes: x86 },
    ]);
    const combined = checkMachO(universal);
    expect(combined.problems).toEqual([]);
    expect(combined.slices).toHaveLength(2);
    const strip = (report: ReturnType<typeof checkMachO>["slices"][number]) => ({
      cputype: report.cputype,
      size: report.size,
      signatureCommands: report.signatureCommands,
      pagesChecked: report.pagesChecked,
    });
    const alone = [checkMachO(arm), checkMachO(x86)];
    for (let index = 0; index < 2; index++) {
      expect(alone[index].problems).toEqual([]);
      expect(strip(combined.slices[index])).toEqual(strip(alone[index].slices[0]));
    }
  });

  it("imports nothing from the source tree or the checker", () => {
    const lines = fs
      .readFileSync(rel("test", "helpers", "Universal.ts"), "utf8")
      .split("\n")
      .filter((line) => /^\s*import\b|\brequire\(|^\s*}?\s*from\s/.test(line));
    for (const line of lines) {
      expect(line).not.toMatch(/src\/|MachOChecker/);
      expect(line).toMatch(/["'](fs|path|crypto|os|buffer|node:[a-z]+)["']/);
    }
  });
});

describe("independent checks", () => {
  // Choices where the contracts leave the shape open:
  //   - the scope is created in a scratch configuration directory whose config.json names the scope with an author
  //   - toolEnv returns PATH from the process environment, or "/usr/bin:/bin" when it is unset
  //   - the sliceSignatureBlobs entries are compared by cputype: x86-64 is 0x01000007, arm64 is 0x0100000c
  const X86_64 = 0x01000007;
  const ARM64 = 0x0100000c;
  const created: string[] = [];
  let savedHome: string | undefined;

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    return dir;
  }

  function genuine(name: string): Buffer {
    return fs.readFileSync(rel("test", "fixtures", "binaries", "genuine", name));
  }

  beforeAll(() => {
    savedHome = process.env.HOME;
    process.env.HOME = tempDir("independent-home-");
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sliceSignatureBlobs gives both slices of a signed universal program in table order, each with a parseable container", async () => {
    const scope = "@infra";
    const configDir = tempDir("independent-config-");
    const scopes = { [scope]: { author: { name: "Signer infra", email: "signer@example.com", url: "" } } };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
    const signing = new Signing(configDir);
    await signing.createCert({ validityDays: 365, scope });
    const file = path.join(tempDir("independent-file-"), "tiny-macho-universal");
    fs.writeFileSync(file, genuine("tiny-macho-universal"));
    await signing.signFileMachO(file, scope);

    const entries = sliceSignatureBlobs(fs.readFileSync(file));
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.cputype)).toEqual([X86_64, ARM64]);
    for (const entry of entries) {
      expect(entry.codeDirectory.readUInt32BE(0)).toBe(0xfade0c02);
      expect(entry.cms).not.toBeNull();
      const info = readSignedData(entry.cms as Buffer);
      expect(info.signers).toHaveLength(1);
    }
  });

  it("sliceSignatureBlobs gives no entry for an unsigned program", () => {
    expect(sliceSignatureBlobs(genuine("tiny-macho-arm64"))).toEqual([]);
  });

  it("sliceSignatureBlobs gives one entry with no container for an ad-hoc signed slice", () => {
    const entries = sliceSignatureBlobs(genuine("tiny-macho-arm64-adhoc"));
    expect(entries).toHaveLength(1);
    expect(entries[0].cputype).toBe(ARM64);
    expect(entries[0].codeDirectory.readUInt32BE(0)).toBe(0xfade0c02);
    expect(entries[0].cms).toBeNull();
  });

  it("toolEnv gives exactly PATH, HOME, LC_ALL and TZ", () => {
    const env = toolEnv("/some/scratch/home");
    expect(Object.keys(env).sort()).toEqual(["HOME", "LC_ALL", "PATH", "TZ"]);
    expect(env.HOME).toBe("/some/scratch/home");
    expect(env.LC_ALL).toBe("C");
    expect(env.TZ).toBe("UTC");
    expect(env.PATH).toBe(process.env.PATH ?? "/usr/bin:/bin");
  });

  it("IndependentCheck imports nothing from the source tree", () => {
    const source = fs.readFileSync(rel("test", "helpers", "IndependentCheck.ts"), "utf8");
    const specifiers = [...source.matchAll(/(?:from\s+|require\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/(^|\/)src(\/|$)/);
    }
  });
});

describe("scratch helpers", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "scratch-helpers-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function filePaths(count: number): string[] {
    const paths: string[] = [];
    for (let index = 0; index < count; index++) {
      const file = path.join(scratch, `file${index}.txt`);
      fs.writeFileSync(file, `content ${index}`);
      paths.push(file);
    }
    return paths;
  }

  for (const name of ["ScratchProjects.ts", "NativeTree.ts", "ElfImage.ts"]) {
    it(`${name} imports nothing from the source tree`, () => {
      const lines = fs
        .readFileSync(rel("test", "helpers", name), "utf8")
        .split("\n")
        .filter((line) => /^\s*import\b|\brequire\(|^\s*}?\s*from\s/.test(line));
      for (const line of lines) {
        expect(line).not.toMatch(/src\/|\.\.\/\.\./);
      }
    });
  }

  it("readBound lets the limit through, rejects the next read and counts the calls", async () => {
    const files = filePaths(5);
    const bound = readBound(3);
    try {
      await fs.promises.readFile(files[0]);
      await fs.promises.readFile(files[1]);
      await fs.promises.readFile(files[2]);
      await expect(fs.promises.readFile(files[3])).rejects.toThrow("walk did not finish: more than 3 file reads");
      expect(bound.count()).toBe(4);
    } finally {
      bound.restore();
    }
  });

  it("readBound reads work again after restore", async () => {
    const files = filePaths(2);
    const bound = readBound(1);
    await fs.promises.readFile(files[0]);
    await expect(fs.promises.readFile(files[1])).rejects.toThrow("more than 1 file reads");
    bound.restore();
    expect((await fs.promises.readFile(files[1])).toString()).toBe("content 1");
    expect((await fs.promises.readFile(files[0])).toString()).toBe("content 0");
  });

  // onRead returns an object with restore(), like readBound, so a case can remove the hook early.
  it("onRead runs the action once, on the first matching read", async () => {
    const dir = path.join(scratch, "x");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const other = filePaths(1)[0];
    const action = jest.fn();
    const hook = onRead("x/package.json", action);
    try {
      await fs.promises.readFile(other);
      expect(action).not.toHaveBeenCalled();
      expect((await fs.promises.readFile(path.join(dir, "package.json"))).toString()).toBe("{}");
      expect(action).toHaveBeenCalledTimes(1);
      await fs.promises.readFile(path.join(dir, "package.json"));
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      hook.restore();
    }
  });

  it("onRead and readBound compose in one case", async () => {
    const dir = path.join(scratch, "x");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "package.json"), "{}");
    const action = jest.fn();
    const bound = readBound(2);
    const hook = onRead("x/package.json", action);
    try {
      await fs.promises.readFile(path.join(dir, "package.json"));
      expect(action).toHaveBeenCalledTimes(1);
      await fs.promises.readFile(path.join(dir, "package.json"));
      await expect(fs.promises.readFile(path.join(dir, "package.json"))).rejects.toThrow("more than 2 file reads");
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      hook.restore();
      bound.restore();
    }
  });

  it("NativeTree toolEnv has exactly PATH and LC_ALL", () => {
    const env = nativeToolEnv();
    expect(Object.keys(env).sort()).toEqual(["LC_ALL", "PATH"]);
    expect(env.LC_ALL).toBe("C");
    expect(env.PATH).toBe(process.env.PATH ?? "/usr/bin:/bin");
  });

  it("elfImage starts with the ELF magic and the requested class and byte order", () => {
    const cases: { bits: 32 | 64; endian: "little" | "big"; klass: number; data: number }[] = [
      { bits: 64, endian: "little", klass: 2, data: 1 },
      { bits: 32, endian: "little", klass: 1, data: 1 },
      { bits: 64, endian: "big", klass: 2, data: 2 },
      { bits: 32, endian: "big", klass: 1, data: 2 },
    ];
    for (const item of cases) {
      const image = elfImage({ bits: item.bits, endian: item.endian, type: "dyn", soname: "libx.so.1" });
      expect(Buffer.isBuffer(image)).toBe(true);
      expect(image.subarray(0, 4)).toEqual(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      expect(image[4]).toBe(item.klass);
      expect(image[5]).toBe(item.data);
    }
  });

  it("elfImage carries the soname text and needed names", () => {
    const image = elfImage({ bits: 64, endian: "little", type: "dyn", soname: "libx.so.1", needed: ["liba.so.2"] });
    expect(image.includes(Buffer.from("libx.so.1\0"))).toBe(true);
    expect(image.includes(Buffer.from("liba.so.2\0"))).toBe(true);
  });

  it("writeProject writes package.json and src/Makefile.am with the given contents", () => {
    const dir = path.join(scratch, "proj");
    writeProject(dir, {
      name: "@t/greet",
      makefileAm: "lib_LTLIBRARIES = libgreet.la\n",
      dependencies: { "@t/other": "file:../other" },
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(manifest.name).toBe("@t/greet");
    expect(manifest.dependencies).toEqual({ "@t/other": "file:../other" });
    expect(fs.readFileSync(path.join(dir, "src", "Makefile.am"), "utf8")).toBe("lib_LTLIBRARIES = libgreet.la\n");
  });

  it("writeProject writes configure.ac when given", () => {
    const dir = path.join(scratch, "proj");
    writeProject(dir, { name: "plain", makefileAm: "", configureAc: "AC_INIT([plain],[1])\n" });
    expect(fs.readFileSync(path.join(dir, "configure.ac"), "utf8")).toBe("AC_INIT([plain],[1])\n");
  });

  it("linkModule makes node_modules/<name> a symbolic link, relative when given relative", () => {
    const target = path.join(scratch, "greet");
    fs.mkdirSync(target);
    const dir = path.join(scratch, "hello");
    fs.mkdirSync(dir);
    linkModule(dir, "@t/greet", "../greet");
    const link = path.join(dir, "node_modules", "@t", "greet");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe("../greet");
    linkModule(dir, "plain", target);
    const plain = path.join(dir, "node_modules", "plain");
    expect(fs.lstatSync(plain).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(plain)).toBe(fs.realpathSync(target));
  });
});

describe("native absence helper", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "native-absent-"));
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function loadComponent(): unknown {
    return require("../native/build/Release/dependency_lister.node");
  }

  function thrownBy(action: () => unknown): NodeJS.ErrnoException {
    try {
      action();
    } catch (error) {
      return error as NodeJS.ErrnoException;
    }
    throw new Error("expected the load to throw");
  }

  it("imports nothing from the source tree", () => {
    const lines = fs
      .readFileSync(rel("test", "helpers", "NativeAbsent.ts"), "utf8")
      .split("\n")
      .filter((line) => /^\s*import\b|\brequire\(|^\s*}?\s*from\s/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/src\/|\.\.\/\.\./);
    }
  });

  it("names the component path the source modules resolve", () => {
    expect(nativeComponentPath).toBe(rel("native", "build", "Release", "dependency_lister.node"));
  });

  it("throws MODULE_NOT_FOUND for the component in absent mode", () => {
    const error = thrownBy(() => withoutNativeComponent(loadComponent));
    expect(error.code).toBe("MODULE_NOT_FOUND");
    expect(error.message).toContain("Cannot find module");
  });

  it("throws the shared library error without that code in fails-to-load mode", () => {
    const error = thrownBy(() => withoutNativeComponent(loadComponent, "fails-to-load"));
    expect(error.message).toBe("libthe-seed.so.1: cannot open shared object file: No such file or directory");
    expect(error.code).toBeUndefined();
  });

  it("returns the value the load function returns", () => {
    const value = { answer: 42 };
    expect(withoutNativeComponent(() => value)).toBe(value);
    expect(withoutNativeComponent(() => value, "fails-to-load")).toBe(value);
  });

  it("absent mode applies whether or not the component exists", () => {
    expect(thrownBy(() => withoutNativeComponent(loadComponent)).code).toBe("MODULE_NOT_FOUND");
  });

  it("loads the real component again after the mock is removed", () => {
    expect(thrownBy(() => withoutNativeComponent(loadComponent)).code).toBe("MODULE_NOT_FOUND");
    jest.dontMock(nativeComponentPath);
    let real: unknown;
    let failure: NodeJS.ErrnoException | null = null;
    try {
      real = loadComponent();
    } catch (error) {
      failure = error as NodeJS.ErrnoException;
    }
    // Where the component is not built the real require fails with the loader's own error, not the mock's.
    if (failure === null) {
      expect(real).toBeTruthy();
    } else {
      expect(failure.message).not.toBe("libthe-seed.so.1: cannot open shared object file: No such file or directory");
      expect(failure.message).toContain("dependency_lister.node");
    }
  });

  it("fileDigest equals the SHA-256 hex of the bytes", () => {
    const file = path.join(scratch, "data.bin");
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]);
    fs.writeFileSync(file, bytes);
    expect(fileDigest(file)).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    fs.writeFileSync(file, Buffer.alloc(0));
    expect(fileDigest(file)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("cli test helpers", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cli-helpers-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("WxsReader imports nothing from the source tree", () => {
    const lines = fs
      .readFileSync(rel("test", "helpers", "WxsReader.ts"), "utf8")
      .split("\n")
      .filter((line) => /^\s*import\b|\brequire\(|^\s*}?\s*from\s/.test(line));
    for (const line of lines) {
      expect(line).not.toMatch(/src\/|\.\.\/\.\./);
    }
  });

  it("WxsReader reads elements and attributes in document order", () => {
    const elements = readWxs(
      "<?xml version=\"1.0\"?>\n<Wix>\n  <Product Name=\"Demo\" Version=\"1.2.3\">\n    <File Id=\"a\" Source=\"dist/a.exe\"/>\n  </Product>\n</Wix>\n",
    );
    expect(elements.map((element) => element.name)).toEqual(["Wix", "Product", "File"]);
    expect(elements[1].attributes).toEqual({ Name: "Demo", Version: "1.2.3" });
    expect(elements[2].attributes).toEqual({ Id: "a", Source: "dist/a.exe" });
  });

  it("WxsReader decodes the five entities", () => {
    const elements = readWxs("<Product Manufacturer=\"Smith &amp; Jones &lt;sales@example.com&gt;\" Name=\"&quot;x&quot; &apos;y&apos;\"/>");
    expect(elements[0].attributes.Manufacturer).toBe("Smith & Jones <sales@example.com>");
    expect(elements[0].attributes.Name).toBe("\"x\" 'y'");
  });

  it("WxsReader decodes decimal and hexadecimal references", () => {
    const elements = readWxs("<Product Name=\"&#65;&#x42;&#x63;\"/>");
    expect(elements[0].attributes.Name).toBe("ABc");
  });

  it("WxsReader rejects any other ampersand and names it", () => {
    expect(() => readWxs("<Product Name=\"Smith & Jones\"/>")).toThrow(/&/);
    expect(() => readWxs("<Product Name=\"a &nbsp; b\"/>")).toThrow(/&nbsp;/);
  });

  it("snapshotTree is equal for an untouched tree", () => {
    fs.mkdirSync(path.join(scratch, "sub"));
    fs.writeFileSync(path.join(scratch, "sub", "a.txt"), "one");
    fs.writeFileSync(path.join(scratch, "b.txt"), "two");
    expect(snapshotTree(scratch)).toEqual(snapshotTree(scratch));
  });

  it("snapshotTree differs after a file is created", () => {
    fs.writeFileSync(path.join(scratch, "a.txt"), "one");
    const before = snapshotTree(scratch);
    fs.writeFileSync(path.join(scratch, "new.txt"), "x");
    expect(snapshotTree(scratch)).not.toEqual(before);
  });

  it("snapshotTree differs after a file is deleted", () => {
    fs.writeFileSync(path.join(scratch, "a.txt"), "one");
    fs.writeFileSync(path.join(scratch, "b.txt"), "two");
    const before = snapshotTree(scratch);
    fs.rmSync(path.join(scratch, "b.txt"));
    expect(snapshotTree(scratch)).not.toEqual(before);
  });

  it("snapshotTree differs after a file changes to other bytes of the same size", () => {
    const file = path.join(scratch, "a.txt");
    fs.writeFileSync(file, "abcd");
    const before = snapshotTree(scratch);
    fs.writeFileSync(file, "abce");
    expect(fs.statSync(file).size).toBe(4);
    expect(snapshotTree(scratch)).not.toEqual(before);
  });
});

// The ASCII pak fixture: a pak built by the tool before the header-size change, together with the
// project it was built from. Interface choices the contracts leave open:
//   - the project's resource entries are { name, filename, size, attributes? }, with filename
//     relative to the project directory;
//   - the pak's header line has the keys name, headerSize, resources in that order, and
//     headerSize is a ten-digit decimal string.
describe("pak fixture", () => {
  const fixtureDir = rel("test", "fixtures", "paks");
  const pakPath = path.join(fixtureDir, "ascii.pak");
  const projectDir = path.join(fixtureDir, "ascii");
  const projectJson = path.join(projectDir, "package.json");

  interface FixtureResource {
    name: string;
    filename: string;
    size: number;
    attributes?: Record<string, string>;
  }

  function firstLine(pak: Buffer): Buffer {
    const end = pak.indexOf(0x0a);
    expect(end).toBeGreaterThanOrEqual(0);
    return pak.subarray(0, end + 1);
  }

  function readResources(): FixtureResource[] {
    const project = JSON.parse(fs.readFileSync(projectJson, "utf8")) as { resources: FixtureResource[] };
    return project.resources;
  }

  it("has the pak, the project and the README", () => {
    expect(fs.statSync(pakPath).isFile()).toBe(true);
    expect(fs.statSync(projectJson).isFile()).toBe(true);
    expect(fs.statSync(path.join(fixtureDir, "README.md")).isFile()).toBe(true);
  });

  it("has an ASCII header line with name, headerSize and resources in order and a matching headerSize", () => {
    const line = firstLine(fs.readFileSync(pakPath));
    for (const byte of line) {
      expect(byte).toBeLessThan(0x80);
    }
    const header = JSON.parse(line.toString("ascii")) as { headerSize: string };
    expect(Object.keys(header)).toEqual(["name", "headerSize", "resources"]);
    expect(header.headerSize).toMatch(/^[0-9]{10}$/);
    expect(parseInt(header.headerSize, 10)).toBe(line.length);
  });

  it("has a project named @scope/name whose resource files all exist", () => {
    const project = JSON.parse(fs.readFileSync(projectJson, "utf8")) as { name: string };
    expect(project.name).toMatch(/^@[^/]+\/[^/]+$/);
    const resources = readResources();
    expect(resources.length).toBeGreaterThan(0);
    for (const resource of resources) {
      const file = path.join(projectDir, resource.filename);
      expect(fs.statSync(file).isFile()).toBe(true);
    }
  });

  it("has a pak whose length is the header line plus the resource files", () => {
    const pak = fs.readFileSync(pakPath);
    const total = readResources().reduce(
      (sum, resource) => sum + fs.statSync(path.join(projectDir, resource.filename)).size,
      0
    );
    expect(pak.length).toBe(firstLine(pak).length + total);
  });

  it("covers an entry with attributes and an empty file", () => {
    const resources = readResources();
    expect(resources.some((r) => r.attributes !== undefined && Object.keys(r.attributes).length > 0)).toBe(true);
    expect(resources.some((r) => fs.statSync(path.join(projectDir, r.filename)).size === 0)).toBe(true);
  });
});
