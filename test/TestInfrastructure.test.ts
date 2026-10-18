import fs from "fs";
import os from "os";
import path from "path";
import * as runChecks from "../scripts/run-checks";
import { KnownGapEntry, runKnownGap, itKnownGap, staleMessage } from "./helpers/KnownGap";
import { expectPresent } from "./helpers/Assert";

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
