/*
 * installLib's output, which `the-seed dependencies install` prints, with a real failing git. This case
 * lives beside Dependencies.test.ts because that file replaces child_process and the step runner.
 *
 * Choices where the contract is open:
 * - A fake `git` first on PATH writes one line to each stream and exits 128; the install directory does
 *   not exist, so the first step is the clone.
 * - The output is reconstructed from console.log and process.stdout.write (standard output) and
 *   console.error and process.stderr.write (standard error), in call order, each console call followed
 *   by a newline. The expected texts were recorded with the 2.0.0 sources.
 */
import fs from "fs";
import os from "os";
import path from "path";
import util from "util";
import Config from "../src/Config";
import { installLib } from "../src/Dependencies";
import { liveProcessGroups } from "../src/ProcessRunner";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("installLib output", () => {
  let tmpDir: string;
  let savedPath: string | undefined;
  let savedCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "install-lib-output-"));
    savedPath = process.env.PATH;
    savedCwd = process.cwd();
    const bin = path.join(tmpDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"),
      "#!/bin/sh\necho \"fake git: $*\"\necho \"fatal: repository not found\" >&2\nexit 128\n", { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + (savedPath ?? "");
    fs.mkdirSync(path.join(tmpDir, "work"));
    process.chdir(path.join(tmpDir, "work"));
  });

  afterEach(() => {
    process.chdir(savedCwd);
    if (savedPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = savedPath;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    expect(liveProcessGroups()).toEqual([]);
  });

  it("prints the 2.0.0 text on both streams when git fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const spies = [
      jest.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
        out.push(util.format(...parts) + "\n");
      }),
      jest.spyOn(console, "error").mockImplementation((...parts: unknown[]) => {
        err.push(util.format(...parts) + "\n");
      }),
      jest.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
        out.push(chunk.toString());
        return true;
      }) as typeof process.stdout.write),
      jest.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
        err.push(chunk.toString());
        return true;
      }) as typeof process.stderr.write),
    ];
    const config = new Config(path.join(tmpDir, "config"));
    config.config.prefix = path.join(tmpDir, "prefix");
    let result;
    try {
      result = await installLib(config, "https://example.invalid/demo.git", "libdemo", "native");
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }

    expect(result).toBe(false);
    expect(out.join("")).toBe(
      "==> clone libdemo: git clone https://example.invalid/demo.git libdemo\n" +
      "fake git: clone https://example.invalid/demo.git libdemo\n"
    );
    expect(err.join("")).toBe(
      "fatal: repository not found\n" +
      "Failed at clone libdemo: git clone https://example.invalid/demo.git libdemo exited with status 128\n"
    );
  });
});
