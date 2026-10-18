"use strict";

// Single entry point for the project checks: typecheck, lint and unit.
// Usage: node scripts/run-checks.js [stage...] [jest args...]

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const packageRoot = path.resolve(__dirname, "..");
const STAGES = ["typecheck", "lint", "unit"];
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
  const ordered = stages.length === 0 ? STAGES.slice() : STAGES.filter((stage) => stages.indexOf(stage) !== -1);
  return { error: null, stages: ordered, jestArgs: rest };
}

function typecheckStage() {
  return runNode([localBin("typescript", "bin", "tsc"), "-p", "tsconfig.test.json"]);
}

function lintStage() {
  return runNode([localBin("eslint", "bin", "eslint.js"), "--ext", ".ts", "src", "test"]);
}

function unitStage(jestArgs) {
  if (!fs.existsSync(path.join(packageRoot, ADDON_PATH))) {
    console.error('Native addon not built: run "npm run build-addon" (libthe-seed must be reachable by pkg-config; see README)');
    return false;
  }

  const resultsFile = path.join(packageRoot, RESULTS_PATH);
  fs.rmSync(resultsFile, { force: true });

  const jestOk = runNode([localBin("jest", "bin", "jest.js"), "--ci", "--json", "--outputFile=" + RESULTS_PATH].concat(jestArgs));

  let results;
  try {
    results = JSON.parse(fs.readFileSync(resultsFile, "utf8"));
  } catch (error) {
    console.error("Jest produced no results");
    return false;
  }

  return jestOk && results.success === true;
}

function runStage(name, jestArgs) {
  console.log("=== " + name + " ===");
  let passed = false;
  try {
    if (name === "typecheck") passed = typecheckStage();
    else if (name === "lint") passed = lintStage();
    else passed = unitStage(jestArgs);
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    passed = false;
  }
  console.log("=== " + name + ": " + (passed ? "PASS" : "FAIL") + " ===");
  return passed;
}

function main(argv) {
  const parsed = parseArguments(argv);
  if (parsed.error) {
    console.error("Unknown stage: " + parsed.error + ". Stages: " + STAGES.join(", "));
    return 2;
  }

  const outcomes = parsed.stages.map((stage) => ({ stage, passed: runStage(stage, parsed.jestArgs) }));

  if (outcomes.length > 1) {
    console.log("Summary: " + outcomes.map((o) => o.stage + " " + (o.passed ? "PASS" : "FAIL")).join(", "));
  }
  return outcomes.every((o) => o.passed) ? 0 : 1;
}

module.exports = { parseArguments, STAGES };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
