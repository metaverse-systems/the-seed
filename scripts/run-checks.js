"use strict";

// Single entry point for the project checks: typecheck, lint and unit, plus the opt-in install check.
// Usage: node scripts/run-checks.js [stage...] [jest args...]

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const STAGES = ["typecheck", "lint", "unit", "install"];
const DEFAULT_STAGES = ["typecheck", "lint", "unit"];
const ADDON_PATH = path.join("native", "build", "Release", "dependency_lister.node");
const RESULTS_PATH = path.join("test-results", "jest.json");

function localBin(...parts) {
  return path.join(packageRoot, "node_modules", ...parts);
}

function runNode(args, options) {
  const result = spawnSync(process.execPath, args, Object.assign({ stdio: "inherit", cwd: packageRoot }, options));
  return result.status === 0;
}

function parseArguments(argv) {
  const stages = [];
  let index = 0;
  while (index < argv.length && STAGES.indexOf(argv[index]) !== -1) {
    stages.push(argv[index]);
    index++;
  }
  const rest = argv.slice(index);
  // A leading word that is not an option or a path is an attempted stage name.
  if (stages.length === 0 && rest.length > 0 && /^[a-z][a-z-]*$/i.test(rest[0]) && !fs.existsSync(path.join(packageRoot, rest[0]))) {
    return { error: rest[0], stages: [], jestArgs: [] };
  }
  const ordered = stages.length === 0 ? DEFAULT_STAGES.slice() : STAGES.filter((stage) => stages.indexOf(stage) !== -1);
  return { error: null, stages: ordered, jestArgs: rest };
}

const GAP_TAG = /^(.*) \[known gap: the-seed-1 finding (\d+)\]$/;
const GENERIC_SIGNATURES = ["error", "expect", "failed", "failure", "exception", "undefined", "assertion"];
const MIN_SIGNATURE_LENGTH = 12;
const NO_DOCUMENTS_NOTICE = "Known-gap references not checked against the review: the parent repository is not present.";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function relativeTestFile(name) {
  return path.isAbsolute(name) ? path.relative(packageRoot, name) : name;
}

// Turns Jest's JSON results into the lines printed after the run.
// Returns { lines, failed }.
function summariseResults(jest, entries) {
  const known = Array.isArray(entries) ? entries : [];
  const groups = Array.isArray(jest && jest.testResults) ? jest.testResults : [];
  const failedGroups = [];
  const failedCases = [];
  const knownGaps = [];
  let passed = 0;
  let failedCount = 0;
  let skipped = 0;
  let groupsFailed = 0;

  for (const group of groups) {
    const file = relativeTestFile(group.name || "");
    const assertions = Array.isArray(group.assertionResults) ? group.assertionResults : [];
    const casesFailedBefore = failedCount;
    for (const result of assertions) {
      const fullName = result.fullName || result.title || "";
      if (result.status === "failed") {
        failedCount++;
        failedCases.push("FAILED: " + file + " › " + fullName);
      } else if (result.status === "passed") {
        const tagged = GAP_TAG.exec(fullName);
        if (tagged) {
          const name = tagged[1];
          const finding = Number(tagged[2]);
          const entry =
            known.find((candidate) => Array.isArray(candidate.cases) && candidate.cases.indexOf(name) !== -1) ||
            known.find((candidate) => candidate.finding === finding);
          const fixedBy = entry && entry.fixedBy ? entry.fixedBy : "unknown";
          knownGaps.push("KNOWN GAP: " + file + " › " + name + " (the-seed-1 finding " + finding + "; fixed by the-seed-1: " + fixedBy + ")");
        } else {
          passed++;
        }
      } else if (result.status === "pending" || result.status === "todo" || result.status === "skipped") {
        skipped++;
      }
    }
    // A group that failed without a failed case (it did not compile, threw at load or in a hook) is named too.
    if (group.status === "failed") {
      groupsFailed++;
      if (failedCount === casesFailedBefore) {
        const message = String(group.message || group.failureMessage || "").split("\n")[0];
        failedGroups.push("FAILED GROUP: " + file + ": " + message);
      }
    }
  }

  const totals =
    "Totals: " + passed + " passed, " + failedCount + " failed, " + knownGaps.length + " known gaps, " + skipped +
    " skipped, " + groups.length + " groups (" + groupsFailed + " failed)";

  return {
    lines: failedGroups.concat(failedCases, knownGaps, [totals]),
    failed: !(jest && jest.success === true) || groupsFailed > 0,
  };
}

// Checks the known-gap list against the markers in the tests and, when present, the review and roadmap.
// calls: { id, title }[]; documents: null or { review, roadmap } (file text).
// Returns { errors, notices }; errors carry only the detail.
function validateKnownGaps(entries, calls, documents) {
  const errors = [];
  const notices = [];

  if (!Array.isArray(entries)) {
    errors.push("test/known-gaps.json must contain a JSON array");
    return { errors, notices };
  }

  const ids = new Set();
  const caseOwners = new Map();

  entries.forEach((entry, index) => {
    const label = entry && typeof entry.id === "string" && entry.id !== "" ? '"' + entry.id + '"' : "entry " + index;
    if (!entry || typeof entry !== "object") {
      errors.push(label + ": must be an object");
      return;
    }
    if (typeof entry.id !== "string" || !/^[a-z0-9-]+$/.test(entry.id)) {
      errors.push(label + ": id must be lower-case letters, digits and hyphens");
    } else if (ids.has(entry.id)) {
      errors.push(label + ": duplicate id (ids must be unique)");
    } else {
      ids.add(entry.id);
    }
    if (entry.review !== "the-seed-1") {
      errors.push(label + ': review must be exactly "the-seed-1"');
    }
    if (!Number.isInteger(entry.finding) || entry.finding < 1 || entry.finding > 17) {
      errors.push(label + ": finding must be an integer from 1 to 17");
    }
    if (typeof entry.fixedBy !== "string" || entry.fixedBy.trim() === "") {
      errors.push(label + ": fixedBy must be a non-empty roadmap task title");
    }
    if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
      errors.push(label + ": reason must be non-empty");
    }
    const signature = typeof entry.signature === "string" ? entry.signature.trim() : "";
    if (signature.length < MIN_SIGNATURE_LENGTH || GENERIC_SIGNATURES.indexOf(signature.toLowerCase()) !== -1) {
      errors.push(label + ": signature must be specific text of at least " + MIN_SIGNATURE_LENGTH + " characters, not a generic word");
    }
    if (!Array.isArray(entry.cases) || entry.cases.length === 0 || entry.cases.some((name) => typeof name !== "string" || name === "")) {
      errors.push(label + ": cases must be a non-empty list of case names");
    } else {
      for (const name of entry.cases) {
        if (caseOwners.has(name)) {
          errors.push(label + ': case "' + name + '" is listed more than once (also in ' + caseOwners.get(name) + ")");
        } else {
          caseOwners.set(name, label);
        }
      }
    }
  });

  const callList = Array.isArray(calls) ? calls : [];
  for (const call of callList) {
    if (!ids.has(call.id)) {
      errors.push('itKnownGap call "' + call.title + '" uses id "' + call.id + '" which is not in test/known-gaps.json');
    }
  }

  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !Array.isArray(entry.cases) || entry.cases.length === 0) continue;
    const own = callList.filter((call) => call.id === entry.id);
    if (own.length === 0) {
      errors.push('"' + entry.id + '": no itKnownGap call uses this id');
      continue;
    }
    const unmatched = entry.cases.slice();
    for (const call of own) {
      const at = unmatched.findIndex((name) => name === call.title || name.endsWith(" " + call.title));
      if (at === -1) {
        errors.push('"' + entry.id + '": itKnownGap call "' + call.title + '" has no matching entry in cases');
      } else {
        unmatched.splice(at, 1);
      }
    }
    for (const name of unmatched) {
      errors.push('"' + entry.id + '": case "' + name + '" has no itKnownGap call');
    }
  }

  if (documents === null || documents === undefined) {
    notices.push(NO_DOCUMENTS_NOTICE);
    return { errors, notices };
  }

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const label = '"' + entry.id + '"';
    if (Number.isInteger(entry.finding) && !new RegExp("^### " + entry.finding + "\\. ", "m").test(documents.review)) {
      errors.push(label + ": the review has no heading '### " + entry.finding + ". ' (finding " + entry.finding + ")");
    }
    if (typeof entry.fixedBy === "string" && entry.fixedBy.trim() !== "") {
      const title = escapeRegExp(entry.fixedBy);
      if (!new RegExp("\\*\\*Task \\d+ — " + title + "\\*\\*").test(documents.roadmap)) {
        errors.push(label + ': the roadmap has no task "' + entry.fixedBy + '"');
      } else if (Number.isInteger(entry.finding)) {
        const row = new RegExp("^\\|\\s*\\d+\\.\\s*" + title + "\\s*\\|([^|]*)\\|", "m").exec(documents.roadmap);
        const listed = row ? row[1].split(",").map((item) => item.trim()) : [];
        if (!row || listed.indexOf(String(entry.finding)) === -1) {
          errors.push(label + ': the roadmap order table row for "' + entry.fixedBy + '" does not list finding ' + entry.finding);
        }
      }
    }
  }

  return { errors, notices };
}

function readKnownGapList(root) {
  const file = path.join(root, "test", "known-gaps.json");
  if (!fs.existsSync(file)) {
    return { error: "test/known-gaps.json is missing", entries: null };
  }
  try {
    return { error: null, entries: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (error) {
    return { error: "test/known-gaps.json is not valid JSON: " + (error && error.message ? error.message : String(error)), entries: null };
  }
}

function findKnownGapCalls(root) {
  const directory = path.join(root, "test");
  const calls = [];
  if (!fs.existsSync(directory)) return calls;
  for (const name of fs.readdirSync(directory).sort()) {
    // The infrastructure tests quote itKnownGap calls as samples.
    if (!name.endsWith(".ts") || name === "TestInfrastructure.test.ts") continue;
    const text = fs.readFileSync(path.join(directory, name), "utf8");
    const pattern = /itKnownGap\(\s*(["'])([^"']+)\1\s*,\s*(["'])((?:(?!\3).)*)\3/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      calls.push({ id: match[2], title: match[4] });
    }
  }
  return calls;
}

// Reads the list, the itKnownGap calls and the parent documents from disk and validates them.
function validateKnownGapFiles(root) {
  const list = readKnownGapList(root);
  if (list.error) {
    return { errors: [list.error], notices: [] };
  }
  const reviewFile = path.join(root, "..", "docs", "reviews", "the-seed-1.md");
  const roadmapFile = path.join(root, "..", "docs", "roadmaps", "the-seed-1.md");
  const documents =
    fs.existsSync(reviewFile) && fs.existsSync(roadmapFile)
      ? { review: fs.readFileSync(reviewFile, "utf8"), roadmap: fs.readFileSync(roadmapFile, "utf8") }
      : null;
  return validateKnownGaps(list.entries, findKnownGapCalls(root), documents);
}

function printSummary(resultsFile) {
  const results = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  const list = readKnownGapList(packageRoot);
  const summary = summariseResults(results, Array.isArray(list.entries) ? list.entries : []);
  summary.lines.forEach((line) => console.log(line));
  return summary;
}

// Lists every file and directory under <root>/home and <root>/tmp as paths relative to root.
function findLeftovers(root) {
  const found = [];
  function walk(relative) {
    let names;
    try {
      names = fs.readdirSync(path.join(root, relative));
    } catch (error) {
      return;
    }
    for (const name of names.sort()) {
      const child = path.join(relative, name);
      found.push(child);
      let isDirectory = false;
      try {
        isDirectory = fs.lstatSync(path.join(root, child)).isDirectory();
      } catch (error) {
        isDirectory = false;
      }
      if (isDirectory) walk(child);
    }
  }
  walk("home");
  walk("tmp");
  return found;
}

function entryType(stats) {
  if (stats.isSymbolicLink()) return "link";
  return stats.isDirectory() ? "directory" : "file";
}

// Describes <home>/the-seed without writing to it: the config.json hash and each entry directly inside.
// Returns { configHash, entries } where entries is null when the directory is absent.
function snapshotRealHome(home) {
  const directory = path.join(home, "the-seed");
  let configHash = "absent";
  try {
    configHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(directory, "config.json"))).digest("hex");
  } catch (error) {
    configHash = "absent";
  }
  let entries = null;
  try {
    entries = {};
    for (const name of fs.readdirSync(directory)) {
      try {
        const stats = fs.lstatSync(path.join(directory, name));
        entries[name] = entryType(stats) + " " + stats.mtime.toISOString();
      } catch (error) {
        // The entry vanished between listing and inspection; a later snapshot will show it as absent.
      }
    }
  } catch (error) {
    entries = null;
  }
  return { configHash, entries };
}

// Returns one "<entry>: <before> -> <after>" line per difference; a missing side is "absent".
function compareRealHome(before, after) {
  const differences = [];
  if (before.configHash !== after.configHash) {
    const shorten = (hash) => (hash === "absent" ? hash : "sha256:" + hash.slice(0, 12));
    differences.push("config.json: " + shorten(before.configHash) + " -> " + shorten(after.configHash));
  }
  const left = before.entries || {};
  const right = after.entries || {};
  const names = Array.from(new Set(Object.keys(left).concat(Object.keys(right)))).sort();
  for (const name of names) {
    const was = Object.prototype.hasOwnProperty.call(left, name) ? left[name] : "absent";
    const now = Object.prototype.hasOwnProperty.call(right, name) ? right[name] : "absent";
    if (was !== now) differences.push(name + ": " + was + " -> " + now);
  }
  if ((before.entries === null) !== (after.entries === null) && names.length === 0) {
    differences.push("the-seed: " + (before.entries === null ? "absent" : "empty directory") + " -> " + (after.entries === null ? "absent" : "empty directory"));
  }
  return differences;
}

function inheritedHome() {
  const value = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
  return value || os.homedir();
}

function typecheckStage() {
  return runNode([localBin("typescript", "bin", "tsc"), "-p", "tsconfig.test.json"]);
}

function lintStage() {
  return runNode([localBin("eslint", "bin", "eslint.js"), "--ext", ".ts", "src", "test"]);
}

function isolatedEnvironment(base, scratchHome, scratchTmp) {
  return Object.assign({}, base, {
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    XDG_CONFIG_HOME: path.join(scratchHome, ".config"),
    TMPDIR: scratchTmp,
    TMP: scratchTmp,
    TEMP: scratchTmp,
    NODE_DISABLE_COMPILE_CACHE: "1",
    THE_SEED_TEST_RUN: "1",
  });
}

function unitStage(jestArgs) {
  if (!fs.existsSync(path.join(packageRoot, ADDON_PATH))) {
    console.error('Native addon not built: run "npm run build-addon" (libthe-seed must be reachable by pkg-config; see README)');
    return false;
  }

  const validation = validateKnownGapFiles(packageRoot);
  validation.notices.forEach((notice) => console.log(notice));
  if (validation.errors.length > 0) {
    validation.errors.forEach((detail) => console.error("MALFORMED KNOWN GAP: " + detail));
    return false;
  }

  const resultsFile = path.join(packageRoot, RESULTS_PATH);
  fs.rmSync(resultsFile, { force: true });
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });

  const realHome = inheritedHome();
  const before = snapshotRealHome(realHome);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "the-seed-tests-"));
  let passed = false;
  try {
    const scratchHome = path.join(root, "home");
    const scratchTmp = path.join(root, "tmp");
    fs.mkdirSync(scratchHome);
    fs.mkdirSync(scratchTmp);

    const environment = isolatedEnvironment(process.env, scratchHome, scratchTmp);
    const jestOk = runNode(
      [localBin("jest", "bin", "jest.js"), "--ci", "--json", "--outputFile=" + RESULTS_PATH].concat(jestArgs),
      { env: environment },
    );

    let results = null;
    try {
      results = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
    } catch (error) {
      console.error("Jest produced no results");
    }

    let summaryFailed = true;
    if (results !== null) {
      const summary = summariseResults(results, readKnownGapList(packageRoot).entries || []);
      summary.lines.forEach((line) => console.log(line));
      summaryFailed = summary.failed;
    }

    const leftovers = findLeftovers(root);
    leftovers.forEach((leftover) => console.log("LEFTOVER: " + leftover.split(path.sep).join("/")));

    passed = results !== null && jestOk && !summaryFailed && leftovers.length === 0;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const differences = compareRealHome(before, snapshotRealHome(realHome));
  differences.forEach((difference) => console.log("REAL HOME CHANGED: " + difference));

  return passed && differences.length === 0;
}

// Builds the environment of a child process of the install check: the case's scratch home, nothing that
// would point at the real prefixes, and the real npm and node-gyp caches.
function installEnvironment(base, scratchHome, caches, extra) {
  const environment = Object.assign({}, base);
  ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "LD_LIBRARY_PATH", "MAKEFLAGS", "MFLAGS", "npm_config_prefix", "NPM_CONFIG_PREFIX"].forEach((name) => {
    delete environment[name];
  });
  return Object.assign(environment, {
    HOME: scratchHome,
    USERPROFILE: scratchHome,
    npm_config_cache: caches.npmCache,
    npm_config_devdir: caches.nodeGypDir,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  }, extra || {});
}

// One line for the summary of the stages that ran, e.g. "Summary: unit PASS, install FAIL".
function summariseStages(outcomes) {
  return "Summary: " + outcomes.map((o) => o.stage + " " + (o.passed ? "PASS" : "FAIL")).join(", ");
}

function npmCommand() {
  if (process.env.npm_execpath) {
    return { command: process.execPath, prefix: [process.env.npm_execpath] };
  }
  return { command: "npm", prefix: [] };
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, Object.assign({ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, options));
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || (result.error ? String(result.error.message) : ""),
  };
}

function digestOf(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function installStage() {
  const requireTools = process.env.THE_SEED_REQUIRE_TOOLS === "1";
  const realHome = inheritedHome();
  const before = snapshotRealHome(realHome);
  const npm = npmCommand();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "the-seed-install-"));
  const failures = [];
  const base = process.env;

  const npmRun = (args, options) => runCommand(npm.command, npm.prefix.concat(args), options);
  const cacheResult = npmRun(["config", "get", "cache"], { env: base, cwd: packageRoot });
  const caches = {
    npmCache: cacheResult.status === 0 && cacheResult.stdout.trim() !== "" ? cacheResult.stdout.trim() : path.join(realHome, ".npm"),
    nodeGypDir: path.join(realHome, ".cache", "node-gyp"),
  };

  const pass = (name) => console.log("INSTALL CHECK PASS: " + name);
  const fail = (name, detail, output) => {
    console.log("INSTALL CHECK FAIL: " + name + ": " + detail);
    if (output) console.log(output);
    failures.push(name);
  };
  const skipOrFail = (name, message) => {
    if (requireTools) {
      fail(name, message);
    } else {
      console.log("SKIPPED CHECK: " + message);
    }
  };
  const combined = (result) => result.stdout + result.stderr;

  const makeHome = (name, prefix) => {
    const home = path.join(root, "home-" + name);
    fs.mkdirSync(path.join(home, "the-seed"), { recursive: true });
    fs.mkdirSync(prefix, { recursive: true });
    const config = {
      prefix,
      scopes: { "@check": { author: { name: "Install Check", email: "check@example.invalid", url: "" } } },
    };
    fs.writeFileSync(path.join(home, "the-seed", "config.json"), JSON.stringify(config, null, 2));
    return home;
  };

  // Installs the tarball into <root>/global-<name> and returns the result with the tool's path.
  const installGlobal = (name, home, tarball, extra) => {
    const globalPrefix = path.join(root, "global-" + name);
    const env = installEnvironment(base, home, caches, extra);
    const result = npmRun(["install", "-g", "--prefix", globalPrefix, "--foreground-scripts", tarball], { env, cwd: root });
    return { result, env, tool: path.join(globalPrefix, "bin", "the-seed") };
  };

  const certAndCopy = (name, env, tool, source) => {
    const work = path.join(root, "work-" + name);
    fs.mkdirSync(work, { recursive: true });
    const copy = path.join(work, path.basename(source));
    fs.copyFileSync(source, copy);
    return { copy, env, tool };
  };

  try {
    // Step 1: pack
    const packDir = path.join(root, "pack");
    fs.mkdirSync(packDir);
    const packEnv = installEnvironment(base, path.join(root, "home-pack"), caches);
    fs.mkdirSync(packEnv.HOME, { recursive: true });
    const pack = npmRun(["pack", "--pack-destination", packDir], { env: packEnv, cwd: packageRoot });
    const tarballs = fs.readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    if (pack.status !== 0 || tarballs.length !== 1) {
      fail("pack", "npm pack exited " + pack.status + " and produced " + tarballs.length + " tarballs", combined(pack));
      return false;
    }
    const tarball = path.join(packDir, tarballs[0]);
    const listing = runCommand("tar", ["tzf", tarball], {});
    const entries = listing.stdout.split("\n");
    if (listing.status !== 0 || entries.indexOf("package/dist/scripts/the-seed.js") === -1) {
      fail("pack", "package/dist/scripts/the-seed.js is not in the tarball", listing.stderr);
    } else if (entries.some((entry) => entry.indexOf("package/test/") === 0)) {
      fail("pack", "the tarball holds package/test/ entries");
    } else {
      pass("pack");
    }

    // Step 2: library location
    // The runner's own environment first; then the configured prefix, which is where the build looks first.
    let probeEnv = Object.assign({}, base);
    if (runCommand("pkg-config", ["--exists", "the-seed"], { env: probeEnv }).status !== 0) {
      const helper = require("../native/pkg-config.js");
      probeEnv = Object.assign({}, base, helper.searchEnv(helper.resolvePrefix(realHome).prefix, base));
    }
    const prefixProbe = runCommand("pkg-config", ["--variable=prefix", "the-seed"], { env: probeEnv });
    const libdirProbe = runCommand("pkg-config", ["--variable=libdir", "the-seed"], { env: probeEnv });
    const libraryPrefix = prefixProbe.status === 0 ? prefixProbe.stdout.trim() : "";
    const libdir = libdirProbe.status === 0 ? libdirProbe.stdout.trim() : "";

    const tiny = path.join(packageRoot, "test", "fixtures", "binaries", "tiny.exe");

    // Case A
    if (libraryPrefix === "" || libdir === "") {
      skipOrFail("A", "install check needs libthe-seed reachable by pkg-config");
    } else {
      const prefixA = path.join(root, "prefix-a");
      const homeA = makeHome("a", prefixA);
      // The configured prefix holds the architecture directory as a link to the library's own directory.
      const archLink = path.join(prefixA, "x86_64-linux-gnu");
      fs.symlinkSync(libraryPrefix, archLink);
      const installed = installGlobal("a", homeA, tarball);
      const problems = [];
      let output = combined(installed.result);
      if (installed.result.status !== 0) problems.push("install exited " + installed.result.status);
      if (output.indexOf("native component built against libthe-seed") === -1) problems.push("no built report in the install output");
      if (problems.length === 0) {
        const help = runCommand(installed.tool, ["help"], { env: installed.env, cwd: root });
        output = combined(help);
        if (help.status !== 0 || help.stdout.indexOf("signing") === -1) problems.push("help exited " + help.status + " or does not list signing");
        const cert = runCommand(installed.tool, ["signing", "create-cert"], { env: installed.env, cwd: root });
        if (cert.status !== 0) {
          problems.push("create-cert exited " + cert.status);
          output = combined(cert);
        } else {
          const work = certAndCopy("a", installed.env, installed.tool, tiny);
          const sign = runCommand(installed.tool, ["signing", "sign", work.copy], { env: installed.env, cwd: root });
          if (sign.status !== 0) {
            problems.push("sign exited " + sign.status);
            output = combined(sign);
          } else if (fs.existsSync(work.copy + ".sig")) {
            problems.push("a detached signature was written");
          } else {
            const verify = runCommand(installed.tool, ["signing", "verify", work.copy], { env: installed.env, cwd: root });
            if (verify.status !== 0) {
              problems.push("verify exited " + verify.status);
              output = combined(verify);
            }
          }
        }
      }
      if (problems.length === 0) pass("A");
      else fail("A", problems.join("; "), output);
    }

    // Case B
    {
      const prefixB = path.join(root, "prefix-b");
      const homeB = makeHome("b", prefixB);
      const emptyPc = path.join(root, "empty-pc");
      fs.mkdirSync(emptyPc);
      const installed = installGlobal("b", homeB, tarball, { PKG_CONFIG_LIBDIR: emptyPc });
      const problems = [];
      let output = combined(installed.result);
      const text = output;
      if (installed.result.status !== 0) problems.push("install exited " + installed.result.status);
      [
        "the native component was not built",
        "libthe-seed",
        path.join(prefixB, "x86_64-linux-gnu", "lib", "pkgconfig"),
        "npm run build-addon",
      ].forEach((expected) => {
        if (text.indexOf(expected) === -1) problems.push("the install output lacks: " + expected);
      });
      if (problems.length === 0) {
        const help = runCommand(installed.tool, ["help"], { env: installed.env, cwd: root });
        if (help.status !== 0) {
          problems.push("help exited " + help.status);
          output = combined(help);
        }
        const cert = runCommand(installed.tool, ["signing", "create-cert"], { env: installed.env, cwd: root });
        if (cert.status !== 0) {
          problems.push("create-cert exited " + cert.status);
          output = combined(cert);
        } else {
          const work = certAndCopy("b", installed.env, installed.tool, tiny);
          const digest = digestOf(work.copy);
          const sign = runCommand(installed.tool, ["signing", "sign", work.copy], { env: installed.env, cwd: root });
          if (sign.status === 0) problems.push("signing a Windows program succeeded without the component");
          if (sign.stderr.indexOf("The native component is not built") === -1 || sign.stderr.indexOf("npm run build-addon") === -1) {
            problems.push("signing's error is not the missing-component message");
            output = combined(sign);
          }
          if (digestOf(work.copy) !== digest) problems.push("the program was changed");
          if (fs.existsSync(work.copy + ".sig")) problems.push("a detached signature was written for a Windows program");

          const linux = path.join(root, "work-b", "true");
          fs.copyFileSync("/bin/true", linux);
          const linuxSign = runCommand(installed.tool, ["signing", "sign", linux], { env: installed.env, cwd: root });
          if (linuxSign.status !== 0 || !fs.existsSync(linux + ".sig")) {
            problems.push("a Linux program was not signed with a detached signature (exit " + linuxSign.status + ")");
            output = combined(linuxSign);
          }
        }
      }
      if (problems.length === 0) pass("B");
      else fail("B", problems.join("; "), output);
    }

    // Case C
    {
      const status = runCommand("git", ["status", "--porcelain"], { cwd: packageRoot });
      const head = runCommand("git", ["rev-parse", "HEAD"], { cwd: packageRoot });
      if (status.status !== 0 || status.stdout.trim() !== "" || head.status !== 0) {
        skipOrFail("C", "install from git needs a clean working tree");
      } else {
        const prefixC = path.join(root, "prefix-c");
        const homeC = makeHome("c", prefixC);
        if (libraryPrefix !== "" && libdir !== "") {
          fs.symlinkSync(libraryPrefix, path.join(prefixC, "x86_64-linux-gnu"));
        }
        const project = path.join(root, "git-project");
        fs.mkdirSync(project);
        fs.writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "install-check", version: "1.0.0", private: true }));
        const env = installEnvironment(base, homeC, caches);
        const installed = npmRun(["install", "git+file://" + packageRoot + "#" + head.stdout.trim()], { env, cwd: project });
        const help = installed.status === 0 ? runCommand(path.join(project, "node_modules", ".bin", "the-seed"), ["help"], { env, cwd: project }) : null;
        if (installed.status !== 0) fail("C", "install exited " + installed.status, combined(installed));
        else if (help.status !== 0) fail("C", "help exited " + help.status, combined(help));
        else pass("C");
      }
    }
  } catch (error) {
    fail("stage", error && error.message ? error.message : String(error));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  const differences = compareRealHome(before, snapshotRealHome(realHome));
  differences.forEach((difference) => console.log("REAL HOME CHANGED: " + difference));
  return failures.length === 0 && differences.length === 0;
}

function runStage(name, jestArgs) {
  console.log("=== " + name + " ===");
  let passed = false;
  try {
    if (name === "typecheck") passed = typecheckStage();
    else if (name === "lint") passed = lintStage();
    else if (name === "install") passed = installStage();
    else passed = unitStage(jestArgs);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    passed = false;
  }
  console.log("=== " + name + ": " + (passed ? "PASS" : "FAIL") + " ===");
  return passed;
}

function main(argv) {
  if (argv[0] === "--summary") {
    if (!argv[1]) {
      console.error("Usage: run-checks.js --summary <jest.json>");
      return 2;
    }
    try {
      printSummary(path.resolve(argv[1]));
    } catch (error) {
      console.error("Cannot read results: " + (error && error.message ? error.message : String(error)));
      return 2;
    }
    return 0;
  }

  const parsed = parseArguments(argv);
  if (parsed.error) {
    console.error("Unknown stage: " + parsed.error + ". Stages: " + STAGES.join(", "));
    return 2;
  }

  const outcomes = parsed.stages.map((stage) => ({ stage, passed: runStage(stage, parsed.jestArgs) }));

  if (outcomes.length > 1) {
    console.log(summariseStages(outcomes));
  }
  return outcomes.every((o) => o.passed) ? 0 : 1;
}

module.exports = { parseArguments, STAGES, summariseStages, installEnvironment, summariseResults, validateKnownGaps, validateKnownGapFiles, findLeftovers, snapshotRealHome, compareRealHome, isolatedEnvironment };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
