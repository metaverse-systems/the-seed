import fs from "fs";
import path from "path";

export interface KnownGapEntry {
  id: string;
  review: string;
  finding: number;
  fixedBy: string;
  signature: string;
  reason: string;
  cases: string[];
}

export type GapOutcome =
  | { kind: "gap" }
  | { kind: "stale" }
  | { kind: "other"; error: unknown };

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function staleMessage(entry: KnownGapEntry, name: string): string {
  return (
    "STALE KNOWN GAP: " + entry.id + " (the-seed-1 finding " + entry.finding + ", fixed by \"" + entry.fixedBy + "\"): " +
    "\"" + name + "\" now passes; remove the itKnownGap marker and the entry from test/known-gaps.json"
  );
}

/** Runs fn and classifies the result against the entry. */
export async function runKnownGap(entry: KnownGapEntry, fn: () => unknown | Promise<unknown>): Promise<GapOutcome> {
  try {
    await fn();
  } catch (error) {
    if (errorText(error).includes(entry.signature)) {
      return { kind: "gap" };
    }
    return { kind: "other", error };
  }
  return { kind: "stale" };
}

function loadEntries(): KnownGapEntry[] {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "known-gaps.json"), "utf8")) as KnownGapEntry[];
}

/** Registers a Jest case "<name> [known gap: the-seed-1 finding <N>]". */
export function itKnownGap(id: string, name: string, fn: () => unknown | Promise<unknown>): void {
  const entry = loadEntries().find((candidate) => candidate.id === id);
  if (!entry) {
    throw new Error("MALFORMED KNOWN GAP: unknown id \"" + id + "\"");
  }
  it(name + " [known gap: the-seed-1 finding " + entry.finding + "]", async () => {
    const outcome = await runKnownGap(entry, fn);
    if (outcome.kind === "other") {
      throw outcome.error;
    }
    if (outcome.kind === "stale") {
      throw new Error(staleMessage(entry, name));
    }
  });
}
