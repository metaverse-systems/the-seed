"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const NATIVE_TRIPLET = "x86_64-linux-gnu";

/**
 * Finds the install prefix the way the tool does, without creating or writing anything.
 * Falls back to the default prefix, with a note saying why, when the configuration cannot be used.
 */
function resolvePrefix(home = os.homedir()) {
  const configPath = path.join(home, "the-seed", "config.json");
  const fallback = (note) => ({ prefix: path.join(home, "the-seed"), source: "default", configPath, note });

  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    return fallback(configPath + " not found");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const first = String((error && error.message) || error).split("\n")[0];
    return fallback(configPath + " is not valid JSON: " + first);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallback(configPath + " must hold a JSON object");
  }
  if ("prefix" in parsed) {
    if (typeof parsed.prefix !== "string" || parsed.prefix === "") {
      return fallback(configPath + ": \"prefix\" must be a non-empty text value");
    }
    return { prefix: parsed.prefix, source: "configuration", configPath, note: null };
  }
  return fallback(null);
}

/** The pkg-config setting that searches the prefix first, then the caller's own PKG_CONFIG_PATH. */
function searchEnv(prefix, inherited = process.env) {
  const own = path.join(prefix, NATIVE_TRIPLET, "lib", "pkgconfig");
  const user = inherited.PKG_CONFIG_PATH;
  return { PKG_CONFIG_PATH: user ? own + ":" + user : own };
}

/** The version of libthe-seed that binding.gyp requires. */
function requiredVersion(bindingGypText) {
  const text = bindingGypText === undefined
    ? fs.readFileSync(path.join(__dirname, "binding.gyp"), "utf8")
    : bindingGypText;
  const match = /the-seed\s*>=\s*([0-9][^\s'"\\)]*)/.exec(text);
  if (!match) {
    throw new Error("binding.gyp does not state a required version of the-seed");
  }
  return match[1];
}

function main(args) {
  const resolution = resolvePrefix();
  const env = { ...process.env, ...searchEnv(resolution.prefix, process.env) };
  const result = spawnSync("pkg-config", args, { encoding: "utf8", env });
  if (result.error) {
    process.stderr.write("pkg-config could not be run: " + result.error.message + "\n");
    return 1;
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  return result.status === null ? 1 : result.status;
}

module.exports = { resolvePrefix, searchEnv, requiredVersion };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
