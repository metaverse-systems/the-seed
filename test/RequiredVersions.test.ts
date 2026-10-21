import fs from "fs";
import path from "path";
import { requiredLibEcsVersion, requiredLibTheSeedVersion } from "../src/Dependencies";

const root = path.join(__dirname, "..");

interface RequiredVersionsModule {
  REQUIRED_VERSIONS: Readonly<{ "ecs-cpp": string; "the-seed": string }>;
}

// Loaded when a case runs, so that this file still loads while the module is absent.
function requiredVersions(): RequiredVersionsModule["REQUIRED_VERSIONS"] {
  return jest.requireActual<RequiredVersionsModule>("../src/RequiredVersions").REQUIRED_VERSIONS;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function readFile(relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("required libthe-seed version", () => {
  const constraint = `the-seed >= ${requiredLibTheSeedVersion}`;

  it.each([
    "templates/program/configure.ac",
    "templates/system/configure.ac"
  ])("%s requires the same version as the installer", (file) => {
    const text = readFile(file);
    if (!text.includes(`[${constraint}]`)) {
      throw new Error(`${file} does not contain [${constraint}]`);
    }
  });

  it("native/binding.gyp asks for the same version in every pkg-config call", () => {
    const file = "native/binding.gyp";
    const lines = readFile(file).split("\n").filter((line) => line.includes("pkg-config"));
    expect(lines.length).toBeGreaterThan(0);
    const wrong = lines.filter((line) => !line.includes(constraint));
    if (wrong.length > 0) {
      throw new Error(
        `${file} has pkg-config calls that do not ask for '${constraint}':\n` +
        wrong.map((line) => line.trim()).join("\n")
      );
    }
  });
});

describe("required versions", () => {
  it("REQUIRED_VERSIONS holds the two minimum versions", () => {
    expect(requiredVersions()).toEqual({ "ecs-cpp": "2.1.0", "the-seed": "0.8.0" });
  });

  it("REQUIRED_VERSIONS is frozen", () => {
    expect(Object.isFrozen(requiredVersions())).toBe(true);
  });

  it("the dependency check asks for the same versions", () => {
    expect(requiredLibEcsVersion).toBe(requiredVersions()["ecs-cpp"]);
    expect(requiredLibTheSeedVersion).toBe(requiredVersions()["the-seed"]);
  });

  it("no TypeScript file under src/ other than RequiredVersions.ts writes either version number", () => {
    const own = path.join(root, "src", "RequiredVersions.ts");
    expect(fs.existsSync(own)).toBe(true);
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(root, "src"))) {
      if (file === own) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const version of ["2.1.0", "0.8.0"]) {
        if (text.includes(version)) offenders.push(`${path.relative(root, file)} contains ${version}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
