/*
 * Tests that the paks `ResourcePak.build` writes are accepted by libthe-seed's own reader, reached through the
 * native component, for names and attributes in any characters.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - The native component offers `readResourcePak(path)` returning `{ names, resources }`; the cases are
 *   skipped with a reason when the component cannot be loaded and required under THE_SEED_REQUIRE_TOOLS=1.
 *   They are reached through `test/helpers/PakReader.ts`, which looks the function up when it is called.
 * - Projects are written by hand into a scratch directory (a `package.json` with a `resources` list), so that
 *   only `build` is under test; `build(packageDir)` is called through a cast that returns the pak path.
 * - The attributes are read back from the description line (the reader ignores them), compared as objects.
 * - The ASCII fixture project is copied into a scratch directory, built, and compared byte for byte with
 *   `test/fixtures/paks/ascii.pak`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import Config from "../src/Config";
import ResourcePak from "../src/ResourcePak";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { nativeReaderAvailable, nativeReaderUnavailableReason, readDescriptionLine, readResourcePak } from "./helpers/PakReader";

interface ResourceSpec {
  name: string;
  filename: string;
  attributes?: { [key: string]: string };
  bytes: Buffer;
}

const everyByte = Buffer.from(Array.from({ length: 256 }, (_, value) => value));

const unicodeResources: ResourceSpec[] = [
  { name: "música", filename: "a.dat", bytes: Buffer.from("two-byte name\n"), attributes: { "tipo": "áudio", "ü": "x" } },
  { name: "日本語", filename: "b.dat", bytes: Buffer.from("three-byte name\n"), attributes: { "種類": "音声", "k": "日本" } },
  { name: "😀", filename: "c.dat", bytes: Buffer.from("four-byte name\n"), attributes: { "😀": "😀😀", "plain": "value" } },
  { name: "plain", filename: "d.dat", bytes: Buffer.from("ascii name\n") },
  { name: "empty", filename: "e.dat", bytes: Buffer.alloc(0) },
  { name: "bytes", filename: "f.dat", bytes: everyByte },
];

const asciiResources: ResourceSpec[] = [
  { name: "musica", filename: "a.dat", bytes: Buffer.from("one\n"), attributes: { type: "audio" } },
  { name: "japanese", filename: "b.dat", bytes: Buffer.from("two\n") },
  { name: "empty", filename: "e.dat", bytes: Buffer.alloc(0) },
  { name: "bytes", filename: "f.dat", bytes: everyByte },
];

describe("resource pak round trip", () => {
  let scratch: string;
  let rp: ResourcePak;

  const buildPak = (dir: string): string => {
    const built = rp.build(dir);
    const name = (JSON.parse(fs.readFileSync(path.join(dir, "package.json")).toString()).name as string).split("/")[1];
    return built ?? path.join(dir, name + ".pak");
  };

  const makeProject = (pakName: string, resources: ResourceSpec[]): string => {
    const dir = fs.mkdtempSync(path.join(scratch, "project-"));
    for (const resource of resources) {
      fs.writeFileSync(path.join(dir, resource.filename), resource.bytes);
    }
    const description = {
      name: pakName,
      version: "0.0.1",
      resources: resources.map((resource) => {
        const entry: { name: string; filename: string; size: number; attributes?: { [key: string]: string } } = {
          name: resource.name,
          filename: resource.filename,
          size: resource.bytes.length,
        };
        if (resource.attributes) entry.attributes = resource.attributes;
        return entry;
      }),
    };
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(description, null, 2) + "\n");
    return dir;
  };

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pak-roundtrip-"));
    const configDir = path.join(scratch, "config");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: scratch, scopes: {} }));
    rp = new ResourcePak(new Config(configDir));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const canRead = (): boolean => optionalExternalCheck("native component", nativeReaderAvailable(), nativeReaderUnavailableReason());

  it("a pak named @t/päk with names and attributes in 1- to 4-byte characters is read back with every resource equal", () => {
    if (!canRead()) return;
    const dir = makeProject("@t/päk", unicodeResources);

    const pak = buildPak(dir);
    const read = readResourcePak(pak);

    expect(path.basename(pak)).toBe("päk.pak");
    expect(read.names).toEqual(unicodeResources.map((resource) => resource.name));
    expect(read.resources).toHaveLength(unicodeResources.length);
    unicodeResources.forEach((resource, index) => {
      expect(Buffer.compare(read.resources[index], fs.readFileSync(path.join(dir, resource.filename)))).toBe(0);
      expect(read.resources[index].length).toBe(resource.bytes.length);
    });
  });

  it("the description line's byte length equals its headerSize and its attributes equal the project's", () => {
    if (!canRead()) return;
    const dir = makeProject("@t/päk", unicodeResources);

    const line = readDescriptionLine(buildPak(dir));

    expect(line.json.headerSize).toMatch(/^\d{10}$/);
    expect(Number(line.json.headerSize)).toBe(line.byteLength);
    expect(line.byteLength).toBeGreaterThan(line.bytes.toString("utf8").length);
    expect(line.json.name).toBe("@t/päk");
    expect(line.json.resources.map((resource) => resource.name)).toEqual(unicodeResources.map((resource) => resource.name));
    unicodeResources.forEach((resource, index) => {
      expect(line.json.resources[index].size).toBe(resource.bytes.length);
      expect(line.json.resources[index].attributes).toEqual(resource.attributes);
    });
  });

  it("names are written as UTF-8 characters, not as escapes", () => {
    const dir = makeProject("@t/päk", unicodeResources);

    const line = readDescriptionLine(buildPak(dir));

    expect(line.bytes.includes(Buffer.from("日本語", "utf8"))).toBe(true);
    expect(line.bytes.includes(Buffer.from("😀", "utf8"))).toBe(true);
    expect(line.bytes.toString("utf8")).not.toContain("\\u");
  });

  it("the same project with ASCII names reads back (guard)", () => {
    if (!canRead()) return;
    const dir = makeProject("@t/pak", asciiResources);

    const pak = buildPak(dir);
    const read = readResourcePak(pak);

    expect(path.basename(pak)).toBe("pak.pak");
    expect(read.names).toEqual(asciiResources.map((resource) => resource.name));
    asciiResources.forEach((resource, index) => {
      expect(Buffer.compare(read.resources[index], resource.bytes)).toBe(0);
    });
    const line = readDescriptionLine(pak);
    expect(Number(line.json.headerSize)).toBe(line.byteLength);
  });

  it("a project with no resources reads back as an empty list (guard)", () => {
    if (!canRead()) return;
    const dir = makeProject("@t/none", []);

    const read = readResourcePak(buildPak(dir));

    expect(read.names).toEqual([]);
    expect(read.resources).toEqual([]);
  });

  it("the ASCII fixture project builds test/fixtures/paks/ascii.pak byte for byte (guard)", () => {
    const fixtures = path.join(__dirname, "fixtures", "paks");
    const dir = path.join(scratch, "ascii");
    fs.cpSync(path.join(fixtures, "ascii"), dir, { recursive: true });

    const pak = buildPak(dir);

    expect(path.basename(pak)).toBe("ascii.pak");
    expect(Buffer.compare(fs.readFileSync(pak), fs.readFileSync(path.join(fixtures, "ascii.pak")))).toBe(0);
  });
});
