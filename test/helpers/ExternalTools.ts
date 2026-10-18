/**
 * Helper for checks that depend on a tool outside this package.
 */

const reported = new Set<string>();

/**
 * True when the check can run. When it cannot: throws if THE_SEED_REQUIRE_TOOLS=1,
 * otherwise prints "SKIPPED CHECK: <name>: <reason>" once per test file and returns false.
 */
export function optionalExternalCheck(name: string, available: boolean, reason: string): boolean {
  if (available) {
    return true;
  }
  if (process.env.THE_SEED_REQUIRE_TOOLS === "1") {
    throw new Error("required external tool missing: " + name + " (" + reason + ")");
  }
  if (!reported.has(name)) {
    reported.add(name);
    console.log("SKIPPED CHECK: " + name + ": " + reason);
  }
  return false;
}
