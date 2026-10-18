import fs from "fs";
import path from "path";
import { requiredLibTheSeedVersion } from "../src/Dependencies";

const root = path.join(__dirname, "..");

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
