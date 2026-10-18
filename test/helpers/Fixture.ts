import fs from "fs";
import path from "path";

/** The autotools project the end-to-end tests build: one program, and two libraries when asked for. */
export const fixtureDir = path.join(__dirname, "..", "fixtures", "autotools-tiny");

export interface FixtureOptions {
  /** Renames the program, the libraries and the printed texts, so two projects never install the same names. */
  name?: string;
  /** The package name written to package.json. */
  packageName?: string;
  /** The `dependencies` written to package.json. */
  dependencies?: Record<string, string>;
  /** Builds the two libraries too, and links the program against them. */
  withLibrary?: boolean;
}

const RENAMED_TEXT_FILES = ["configure.ac", path.join("src", "Makefile.am"), path.join("src", "library.am.in"), path.join("src", "tiny.c"), path.join("src", "tinygreet.c"), path.join("src", "tinyrelink.c")];

/** Copies the fixture to dest, applying the options. */
export function copyFixture(dest: string, options: FixtureOptions = {}): void {
  fs.cpSync(fixtureDir, dest, { recursive: true });
  if (options.name !== undefined && options.name !== "tiny") {
    if (!/^[a-z][a-z0-9]*$/.test(options.name)) {
      throw new Error("fixture name must be lower-case letters and digits: " + options.name);
    }
    for (const file of RENAMED_TEXT_FILES) {
      const from = path.join(dest, file);
      const text = fs.readFileSync(from, "utf-8").split("tiny").join(options.name);
      fs.writeFileSync(from, text);
      if (file.startsWith("src" + path.sep) && file.endsWith(".c")) {
        fs.renameSync(from, path.join(dest, file.split("tiny").join(options.name)));
      }
    }
  }
  if (options.packageName !== undefined || options.dependencies !== undefined) {
    const manifestPath = path.join(dest, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    if (options.packageName !== undefined) {
      manifest.name = options.packageName;
    }
    if (options.dependencies !== undefined) {
      manifest.dependencies = options.dependencies;
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  }
  if (options.withLibrary) {
    fs.writeFileSync(path.join(dest, "with-library"), "");
  }
}
