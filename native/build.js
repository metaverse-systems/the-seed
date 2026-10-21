"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { resolvePrefix, searchEnv, requiredVersion } = require("./pkg-config.js");

const NATIVE_DIR = __dirname;
const KEPT_OUTPUT_LINES = 20;
const COMPONENT_FILE = path.join("build", "Release", "the_seed_native.node");

/** Probes that look at the real machine; tests replace them. */
function realProbes(env, nativeDir, required) {
  const pathDirs = (env.PATH || "").split(path.delimiter).filter((dir) => dir !== "");
  const isFile = (file) => {
    try {
      return fs.statSync(file).isFile();
    } catch (error) {
      return false;
    }
  };
  return {
    env,
    requiredVersion: required,
    which: (command) => {
      if (command.includes("/")) {
        return isFile(command) ? command : null;
      }
      for (const dir of pathDirs) {
        const candidate = path.join(dir, command);
        if (isFile(candidate)) {
          return candidate;
        }
      }
      return null;
    },
    runs: (command, args) => {
      const result = spawnSync(command, args, { env, stdio: "ignore" });
      return !result.error && result.status === 0;
    },
    exists: isFile,
    resolveModule: (name, paths) => {
      try {
        return require.resolve(name, { paths });
      } catch (error) {
        return null;
      }
    },
    pkgConfig: (args) => {
      const result = spawnSync("pkg-config", args, { encoding: "utf8", env });
      return { status: result.error ? null : result.status, stdout: result.stdout || "" };
    }
  };
}

function checkCompiler(probes) {
  const cxx = probes.env.CXX ? String(probes.env.CXX).trim().split(/\s+/)[0] : "";
  const candidates = cxx !== "" ? [cxx] : ["c++", "g++"];
  const detail = cxx !== "" ? "tried $CXX=" + probes.env.CXX : "tried c++, g++";
  for (const candidate of candidates) {
    if (probes.which(candidate) !== null && probes.runs(candidate, ["--version"])) {
      return { name: "compiler", state: "present", detail: candidate, found: null };
    }
  }
  return { name: "compiler", state: "missing", detail, found: null };
}

function checkOnPath(probes, name) {
  const found = probes.which(name);
  return { name, state: found !== null ? "present" : "missing", detail: found || "", found: null };
}

function checkNodeGyp(probes) {
  const own = probes.env.npm_config_node_gyp;
  if (own && probes.exists(own)) {
    return { name: "node-gyp", state: "present", detail: own, found: null };
  }
  return checkOnPath(probes, "node-gyp");
}

function checkAddonApi(probes) {
  const found = probes.resolveModule("node-addon-api", [NATIVE_DIR]);
  return { name: "node-addon-api", state: found !== null ? "present" : "missing", detail: found || "", found: null };
}

function checkLibrary(probes, pkgConfigPresent) {
  const missing = { name: "libthe-seed", state: "missing", detail: "not found", found: null };
  if (!pkgConfigPresent) {
    return missing;
  }
  const version = probes.pkgConfig(["--modversion", "the-seed"]);
  if (version.status !== 0) {
    return missing;
  }
  const found = version.stdout.trim();
  const recent = probes.pkgConfig(["--atleast-version=" + probes.requiredVersion, "the-seed"]);
  if (recent.status === 0) {
    return { name: "libthe-seed", state: "present", detail: found, found };
  }
  return {
    name: "libthe-seed",
    state: "too-old",
    detail: "found " + found + ", " + probes.requiredVersion + " or later required",
    found
  };
}

/** Checks every prerequisite; none stops the others. */
function checkPrerequisites(probes) {
  const pkgConfig = checkOnPath(probes, "pkg-config");
  return [
    checkCompiler(probes),
    checkOnPath(probes, "make"),
    checkOnPath(probes, "python3"),
    pkgConfig,
    checkNodeGyp(probes),
    checkAddonApi(probes),
    checkLibrary(probes, pkgConfig.state === "present")
  ];
}

function missingLine(item, required) {
  switch (item.name) {
    case "compiler":
      return "a C++ compiler (" + item.detail + ")";
    case "node-gyp":
      return "node-gyp (it comes with npm)";
    case "node-addon-api":
      return "node-addon-api (reinstall the package)";
    case "libthe-seed":
      return "libthe-seed " + required + " or later (" + (item.state === "too-old" ? "found " + item.found : "not found") + ")";
    default:
      return item.name;
  }
}

/** Renders the report that is shown after the build. */
function renderReport(report) {
  if (report.built) {
    return "the-seed: native component built against libthe-seed " + report.libraryVersion + " (" + report.libraryDir + ").";
  }
  const lines = ["the-seed: the native component was not built."];
  for (const item of report.missing) {
    lines.push("  Missing: " + missingLine(item, report.requiredVersion));
  }
  if (report.buildOutput !== null) {
    lines.push("  Build failed:");
    for (const line of report.buildOutput.split("\n")) {
      lines.push("    " + line);
    }
  }
  const searched = searchEnv(report.prefix.prefix, {}).PKG_CONFIG_PATH;
  const origin = report.prefix.source === "configuration"
    ? "prefix from " + report.prefix.configPath
    : "default prefix: " + (report.prefix.note || "no configuration");
  lines.push("  Searched for libthe-seed in: " + searched + " (" + origin + "), then PKG_CONFIG_PATH, then the system directories.");
  lines.push("  Every other command works. Commands that need the native component: signing and verifying Windows programs, Mac programs and installers, package, installer, Windows builds.");
  lines.push("  To build it: install what is missing (run \"the-seed dependencies install\" for libthe-seed), then: cd \"" + report.packageRoot + "\" && npm run build-addon");
  return lines.join("\n");
}

/** Runs the build command, streaming its output and keeping all of it for the report. */
function spawnRunner(invocation) {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = [];
    const collect = (chunk) => {
      chunks.push(chunk);
      process.stdout.write(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      chunks.push(Buffer.from(String(error.message) + "\n"));
      resolve({ status: null, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (status) => {
      resolve({ status, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

function openTty() {
  try {
    const fd = fs.openSync("/dev/tty", "w");
    return {
      write: (text) => {
        fs.writeSync(fd, text);
      },
      close: () => {
        fs.closeSync(fd);
      }
    };
  } catch (error) {
    return null;
  }
}

function lastLines(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.slice(-KEPT_OUTPUT_LINES).join("\n");
}

/** Builds the native component and prints the report; resolves to the exit status. */
async function run(options = {}) {
  const install = options.install === true;
  const nativeDir = options.nativeDir || NATIVE_DIR;
  const baseEnv = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const openTerminal = options.openTerminal || openTty;
  const runner = options.runner || spawnRunner;

  fs.rmSync(path.join(nativeDir, "build"), { recursive: true, force: true });

  const prefix = resolvePrefix(options.home || os.homedir());
  const search = searchEnv(prefix.prefix, baseEnv);
  const env = { ...baseEnv, ...search };
  delete env.MAKEFLAGS;
  delete env.MFLAGS;

  const required = options.probes
    ? options.probes.requiredVersion
    : requiredVersion(fs.readFileSync(path.join(nativeDir, "binding.gyp"), "utf8"));
  const probes = options.probes || realProbes(env, nativeDir, required);

  const checks = checkPrerequisites(probes);
  const missing = checks.filter((item) => item.state !== "present");
  const report = {
    built: false,
    libraryVersion: null,
    libraryDir: null,
    missing,
    buildOutput: null,
    prefix,
    packageRoot: path.dirname(nativeDir),
    requiredVersion: required
  };

  if (missing.length === 0) {
    const gyp = baseEnv.npm_config_node_gyp && probes.exists(baseEnv.npm_config_node_gyp) ? baseEnv.npm_config_node_gyp : null;
    const gypArgs = ["rebuild", "--jobs=4", "--directory=" + nativeDir];
    const result = await runner({
      command: gyp !== null ? process.execPath : "node-gyp",
      args: gyp !== null ? [gyp, ...gypArgs] : gypArgs,
      env,
      cwd: nativeDir
    });
    if (result.status === 0 && fs.existsSync(path.join(nativeDir, COMPONENT_FILE))) {
      report.built = true;
      report.libraryVersion = probes.pkgConfig(["--modversion", "the-seed"]).stdout.trim();
      report.libraryDir = probes.pkgConfig(["--variable=libdir", "the-seed"]).stdout.trim();
    } else {
      report.buildOutput = lastLines(result.output || "");
    }
  }

  const text = renderReport(report) + "\n";
  stdout.write(text);
  if (install && !stdout.isTTY) {
    const terminal = openTerminal();
    if (terminal) {
      try {
        terminal.write(text);
      } finally {
        if (terminal.close) {
          terminal.close();
        }
      }
    }
  }

  if (install) {
    return 0;
  }
  return report.built ? 0 : 1;
}

module.exports = { checkPrerequisites, renderReport, run };

if (require.main === module) {
  run({ install: process.argv.includes("--install") }).then(
    (status) => {
      process.exitCode = status;
    },
    (error) => {
      process.stderr.write("the-seed: the native component build could not run: " + ((error && error.message) || error) + "\n");
      process.exitCode = process.argv.includes("--install") ? 0 : 1;
    }
  );
}
