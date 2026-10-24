/*
 * `the-seed package` prints exactly what 2.0.0 printed. The expected text below was recorded with the
 * 2.0.0 sources; the other command-line cases for `package` and `installer windows` keep pinning their
 * own texts.
 *
 * `the-seed signing cert-info` and `the-seed signing verify` print exactly what they printed before the
 * subject formatter became public. Their expected texts were recorded with the sources of f62b796; the
 * fingerprint, the validity dates and the scratch paths change with every run and are filled in from the
 * certificate and the scratch directory, while every other character is written out.
 *
 * Choices where the contract is open:
 * - The command runs in-process through runTheSeed with a scratch home and configuration, and the
 *   native component's dependency lister is replaced, as in Package.test.ts.
 * - The scratch project is a signed program that needs a library installed in the prefix under a
 *   different file name than the one it is loaded by, and a system library that is not packaged, so
 *   every kind of line a successful run prints appears once.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { targets } from "../src/Build";
import Signing from "../src/Signing";
import { DependencyResultType } from "../src/types";
import { elfImage } from "./helpers/ElfImage";
import { runTheSeed } from "./helpers/RunCli";

jest.mock("../native/build/Release/the_seed_native.node", () => ({
  listDependencies: jest.fn()
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
const mockedListDependencies = require("../native/build/Release/the_seed_native.node").listDependencies as jest.MockedFunction<
  (binaryPaths: string[], searchPaths: string[]) => DependencyResultType
>;

describe("the-seed package output", () => {
  let root: string;
  let configDir: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-output-identity-")));
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(root, "prefix"), scopes: {} }));
    mockedListDependencies.mockReset();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prints the 2.0.0 text for a successful run, with status 0 and nothing on standard error", async () => {
    const projectDir = path.join(root, "hello");
    const libsDir = path.join(projectDir, "src", ".libs");
    fs.mkdirSync(libsDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "src", "Makefile.am"), "bin_PROGRAMS = hello\nhello_SOURCES = hello.cpp\n");
    fs.writeFileSync(path.join(libsDir, "hello"), "program content");
    fs.writeFileSync(path.join(libsDir, "hello.sig"), "program signature");

    const libDir = path.join(root, "prefix", targets.native, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const library = path.join(libDir, "libbar.so.2.0.0");
    fs.writeFileSync(library, elfImage({ bits: 64, endian: "little", type: "dyn", soname: "libbar.so.2" }));
    fs.symlinkSync("libbar.so.2.0.0", path.join(libDir, "libbar.so.2"));

    mockedListDependencies.mockImplementation((inputs: string[]): DependencyResultType => inputs.some((input) => input.endsWith("hello"))
      ? { dependencies: { [path.join(libDir, "libbar.so.2")]: inputs, "libc.so.6": inputs }, errors: {} }
      : { dependencies: {}, errors: {} });
    const outputDir = path.join(root, "release");

    const run = await runTheSeed(["package", outputDir, projectDir], { home: root, configDir, cwd: root });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      "Copying hello...\n" +
      "Copying hello.sig...\n" +
      "Copying libbar.so.2 (from " + library + ")...\n" +
      "Packaged 3 files into " + outputDir + "/ (1 signature included)\n" +
      "Not packaged (expected on the target system):\n" +
      "  libc.so.6 (needed by hello)\n"
    );
    expect(fs.readdirSync(outputDir).sort()).toEqual(["hello", "hello.sig", "libbar.so.2"]);
  });
});

describe("the-seed signing output", () => {
  let root: string;
  let configDir: string;
  let signing: Signing;

  /** The day of a date as the command line prints it. */
  function day(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cli-output-identity-")));
    configDir = path.join(root, "config");
    fs.mkdirSync(configDir);
    const scopes = { "@ident": { author: { name: "Ida Entity", email: "ida@example.com", url: "" } } };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(root, "prefix"), scopes }));
    signing = new Signing(configDir);
    await signing.createCert({ scope: "@ident", validityDays: 365 });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("prints the earlier text for cert-info, with status 0 and nothing on standard error", async () => {
    const info = signing.getCertInfo("@ident");
    if (!info) {
      throw new Error("the scratch certificate was not created");
    }

    const run = await runTheSeed(["signing", "cert-info", "--scope", "@ident"], { home: root, configDir, cwd: root });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      "Signing Certificate:\n" +
      "  Subject:     CN=Ida Entity, EMAIL=ida@example.com, O=@ident\n" +
      "  Issuer:      self-signed\n" +
      "  Fingerprint: " + info.fingerprint + "\n" +
      "  Key Type:    ECDSA P-256\n" +
      "  Valid:        " + day(info.notBefore) + " to " + day(info.notAfter) + "\n" +
      "  Status:      Active\n" +
      "  Location:    " + path.join(configDir, "signing", "@ident", "cert.pem") + "\n"
    );
  });

  it("prints the earlier text for verify of a signed file, with status 0 and nothing on standard error", async () => {
    const info = signing.getCertInfo("@ident");
    if (!info) {
      throw new Error("the scratch certificate was not created");
    }
    const file = path.join(root, "program.bin");
    fs.writeFileSync(file, Buffer.from([0x7f, 0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10]));
    await signing.signFile(file, { scope: "@ident" });

    const run = await runTheSeed(["signing", "verify", file], { home: root, configDir, cwd: root });

    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      "Verification: VALID \u2713\n" +
      "  File:        " + file + "\n" +
      "  Form:        detached (program.bin.sig)\n" +
      "  Integrity:   intact (signature over the whole file)\n" +
      "  Trust:       trusted: certificate of scope @ident\n" +
      "  Signer:      CN=Ida Entity, EMAIL=ida@example.com, O=@ident\n" +
      "  Issuer:      self-signed\n" +
      "  Fingerprint: " + info.fingerprint + "\n" +
      "  Valid:       " + day(info.notBefore) + " to " + day(info.notAfter) + "\n" +
      "  Not checked: certificate chains, revocation, signing time, acceptance by the platform's own verifier\n"
    );
  });
});
