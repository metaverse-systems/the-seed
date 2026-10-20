import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { expectPresent } from "./helpers/Assert";
import { runTheSeed, snapshotTree } from "./helpers/RunCli";
import { replaceScopeKey } from "./helpers/IndependentCheck";
import { makeUniversal } from "./helpers/Universal";
import { fileDigest, nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";

// The commands, run through runTheSeed with a scratch configuration directory and a scratch HOME.
// Two configurations are used: A (scope @ta) and B (scope @tb). The command's status is the process
// exit status the command line ends with. Usage errors are written to stderr as three lines, and the
// tests below fix the wording:
//   - a --cert without a value:  "Error: --cert needs a value."  followed by the usage line
//   - an unknown option:         'Error: Unknown option "--bogus" for "the-seed signing verify".'  followed by the usage line
//   - no path:                   "Error: <path> is required."  followed by the usage line
//   - the usage line:            "Usage: the-seed signing verify [--cert <file>]... <path>"
// The --scope cases fix these choices: the configuration for them has the scopes @a and @b, each with
// a certificate made in the scratch configuration directory; "--scope @nope" is refused with
// status 2 before any file is written, naming the scope and listing "@a, @b"; two scopes, no
// --scope and not interactive is status 3 naming "--scope".
// Directory report (forms these tests fix):
//   - each per-file line is two spaces, the headline word padded with spaces to 17 characters, then
//     the text (so the text of every line starts in the same column)
//   - the em dash " — " separates a path from its reason
//   - the "Verifying directory:" line shows the path as given on the command line
//   - a missing listed file prints "MISSING" and its path with no reason
//   - the "Certificate:" line is "<subject>  <fingerprint>  (<note>)", the note being
//     "fingerprint matches the manifest" or "fingerprint does NOT match the manifest's recorded fingerprint <recorded>"

const USAGE = "Usage: the-seed signing verify [--cert <file>]... <path>";

const created: string[] = [];

interface CommandRun {
  status: number;
  out: string;
  err: string;
}

// The captured streams are compared without the newline that ends the last line.
function lines(text: string): string {
  return text.replace(/\n$/, "");
}

async function runSigning(command: string, args: string[], configDir: string, home: string): Promise<CommandRun> {
  const run = await runTheSeed(["signing", command, ...args], { home, configDir });
  return { status: run.status, out: lines(run.stdout), err: lines(run.stderr) };
}

async function runVerify(args: string[], configDir: string, home: string): Promise<CommandRun> {
  return runSigning("verify", args, configDir, home);
}

async function runSign(args: string[], configDir: string, home: string): Promise<CommandRun> {
  return runSigning("sign", args, configDir, home);
}

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function makeConfiguration(scope: string): Promise<{ signing: Signing; configDir: string; certFile: string }> {
  const configDir = tempDir("cli-config-");
  const scopes = { [scope]: { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } } };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
  const signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope });
  const certFile = path.join(tempDir("cli-cert-"), scope.slice(1) + ".pem");
  await signing.exportCert(certFile, scope);
  return { signing, configDir, certFile };
}

let A: Awaited<ReturnType<typeof makeConfiguration>>;
let B: Awaited<ReturnType<typeof makeConfiguration>>;
let home: string;
let signedInB: string;

beforeAll(async () => {
  home = tempDir("cli-home-");
  A = await makeConfiguration("@ta");
  B = await makeConfiguration("@tb");
  signedInB = path.join(tempDir("cli-file-"), "tiny-macho-arm64");
  fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), signedInB);
  await B.signing.signFileMachO(signedInB, "@tb");
});

afterAll(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("signing verify --cert", () => {
  it("exits 4 and prints the untrusted headline, the trust line and the signer's fingerprint without --cert", async () => {
    const run = await runVerify([signedInB], A.configDir, home);
    expect(run.status).toBe(4);
    expect(run.out).toContain("Verification: INTACT, NOT TRUSTED");
    expect(run.out).toContain("Trust:       not trusted: signer certificate is not one of the trusted certificates");
    expect(run.out).toContain("Fingerprint: " + B.signing.getCertInfo("@tb")?.fingerprint);
  });

  it("trusts the certificate named by --cert placed before the path", async () => {
    const run = await runVerify(["--cert", B.certFile, signedInB], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out).toContain("Verification: VALID");
    expect(run.out).toContain("Trust:       trusted: supplied certificate " + B.certFile);
  });

  it("trusts the certificate named by --cert placed after the path", async () => {
    const run = await runVerify([signedInB, "--cert", B.certFile], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out).toContain("Verification: VALID");
  });

  it("accepts --cert more than once, trusting a signer found in the second file", async () => {
    const run = await runVerify(["--cert", A.certFile, "--cert", B.certFile, signedInB], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out).toContain("Trust:       trusted: supplied certificate " + B.certFile);
  });

  it("replaces the configured certificates: a file signed in A is not trusted when only B's certificate is named", async () => {
    const file = path.join(tempDir("cli-file-"), "tiny-macho-arm64");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
    await A.signing.signFileMachO(file, "@ta");
    expect((await runVerify([file], A.configDir, home)).status).toBe(0);
    expect((await runVerify(["--cert", B.certFile, file], A.configDir, home)).status).toBe(4);
  });

  it("never takes the path from a --cert value: with only --cert <file> the path is missing", async () => {
    const run = await runVerify(["--cert", B.certFile], A.configDir, home);
    expect(run.status).toBe(3);
    expect(run.err).toContain("Error: <path> is required.");
    expect(run.err).toContain(USAGE);
    expect(run.out).not.toContain("Verification:");
  });

  describe("an unusable --cert file", () => {
    it("exits 2 for a file that does not exist, naming it, and prints no verification", async () => {
      const missing = path.join(tempDir("cli-missing-"), "nope.pem");
      const run = await runVerify(["--cert", missing, signedInB], A.configDir, home);
      expect(run.status).toBe(2);
      expect(run.err).toContain("Trusted certificate file " + missing + " does not exist");
      expect(run.out).not.toContain("Verification:");
    });

    it("exits 2 for a file that cannot be read, naming it, and prints no verification (skipped as root)", async () => {
      if (process.getuid?.() === 0) {
        console.log("SKIPPED CHECK: unreadable --cert file: running as root, a mode 000 file can be read");
        return;
      }
      const unreadable = path.join(tempDir("cli-unreadable-"), "locked.pem");
      fs.copyFileSync(B.certFile, unreadable);
      fs.chmodSync(unreadable, 0o000);
      try {
        const run = await runVerify(["--cert", unreadable, signedInB], A.configDir, home);
        expect(run.status).toBe(2);
        expect(run.err).toContain("Trusted certificate file " + unreadable + " cannot be read");
        expect(run.out).not.toContain("Verification:");
      } finally {
        fs.chmodSync(unreadable, 0o600);
      }
    });

    it("exits 2 for a text file that holds no certificate, naming it, and prints no verification", async () => {
      const text = path.join(tempDir("cli-text-"), "notes.txt");
      fs.writeFileSync(text, "this is not a certificate\n");
      const run = await runVerify(["--cert", text, signedInB], A.configDir, home);
      expect(run.status).toBe(2);
      expect(run.err).toContain("Trusted certificate file " + text + " holds no certificate");
      expect(run.out).not.toContain("Verification:");
    });

    it("stops before anything is verified even when the path does not exist", async () => {
      const missing = path.join(tempDir("cli-missing-"), "nope.pem");
      const run = await runVerify(["--cert", missing, path.join(tempDir("cli-none-"), "absent.bin")], A.configDir, home);
      expect(run.status).toBe(2);
      expect(run.err).toContain("Trusted certificate file " + missing + " does not exist");
      expect(run.err).not.toContain("File not found");
    });
  });

  describe("usage errors", () => {
    it("exits 3 with the usage line for --cert without a value", async () => {
      const run = await runVerify([signedInB, "--cert"], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Error: --cert needs a value.");
      expect(run.err + run.out).toContain(USAGE);
      expect(run.out).not.toContain("Verification:");
    });

    it("exits 3 with the usage line for an unknown option", async () => {
      const run = await runVerify(["--bogus", signedInB], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Error: Unknown option \"--bogus\" for \"the-seed signing verify\".");
      expect(run.err + run.out).toContain(USAGE);
      expect(run.out).not.toContain("Verification:");
    });
  });
});

describe("signing verify <directory>", () => {
  const NOT_CHECKED_LINE = "  Not checked: certificate chains, revocation, signing time, acceptance by the platform's own verifier";
  const tiny = path.join(__dirname, "fixtures", "binaries", "tiny.exe");
  let root: string;
  let dir: string;

  /** One line of the per-file list: two spaces, the headline padded to 17, the text. */
  function line(word: string, text: string): string {
    return "  " + word.padEnd(17) + text;
  }

  function readManifest(): { version: number; skipped?: string[]; certificateFingerprint: string; certificate?: string; files: Array<{ path: string; signatureFile: string | null; algorithm: string; signature: string; signatureType?: string }> } {
    return JSON.parse(fs.readFileSync(path.join(dir, ".signatures.json"), "utf-8"));
  }

  function writeManifest(manifest: unknown): void {
    fs.writeFileSync(path.join(dir, ".signatures.json"), JSON.stringify(manifest, null, 2));
  }

  beforeEach(() => {
    root = tempDir("cli-dir-");
    dir = path.join(root, "tree");
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.bin"), Buffer.from([0, ...Array.from({ length: 63 }, (_, index) => (index * 7 + 3) & 0xff)]));
    fs.writeFileSync(path.join(dir, "lib", "b.bin"), Buffer.from([0, ...Array.from({ length: 79 }, (_, index) => (index * 11 + 5) & 0xff)]));
    fs.copyFileSync(tiny, path.join(dir, "tiny.exe"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("exits 0 and prints the full report for a directory that is as it was signed", async () => {
    await A.signing.signDirectory(dir, { scope: "@ta" });
    const run = await runVerify([dir], A.configDir, home);

    expect(run.status).toBe(0);
    const lines = run.out.split("\n");
    expect(lines[0]).toBe("Verifying directory: " + dir);
    expect(run.out).toMatch(/^ {2}Manifest: {4}\.signatures\.json, current format \(version 2\), signed \d{4}-\d{2}-\d{2}T/m);
    const cert = A.signing.getCertInfo("@ta");
    expect(run.out).toContain("  Certificate: ");
    expect(run.out).toContain(expectPresent(cert, "certificate").fingerprint + "  (fingerprint matches the manifest)");
    expect(run.out).toContain("  Trust:       trusted: certificate of scope @ta");
    expect(lines).toContain(line("VALID", "a.bin (detached; signer matches the manifest)"));
    expect(lines).toContain(line("VALID", "lib/b.bin (detached; signer matches the manifest)"));
    expect(lines).toContain(line("VALID", "tiny.exe (Windows program; signer matches the manifest)"));
    expect(lines).toContain(NOT_CHECKED_LINE);
    expect(run.out).toContain("  Result: PASS (valid 3, untrusted 0, invalid 0, not fully signed 0, not checked 0, missing 0, unlisted 0; skipped 0)");
    expect(run.out).not.toContain("Warning:");
  });

  it("exits 4 and prints NOT TRUSTED for a directory signed in B, each file still shown as intact", async () => {
    await B.signing.signDirectory(dir, { scope: "@tb" });
    const run = await runVerify([dir], A.configDir, home);

    expect(run.status).toBe(4);
    expect(run.out).toContain("  Trust:       not trusted: signer certificate is not one of the trusted certificates");
    expect(run.out).toMatch(/^ {2}UNTRUSTED {8}a\.bin/m);
    expect(run.out).toMatch(/^ {2}UNTRUSTED {8}tiny\.exe/m);
    expect(run.out).toContain("  Result: NOT TRUSTED (valid 0, untrusted 3, invalid 0, not fully signed 0, not checked 0, missing 0, unlisted 0; skipped 0)");

    const withCert = await runVerify(["--cert", B.certFile, dir], A.configDir, home);
    expect(withCert.status).toBe(0);
    expect(withCert.out).toContain("Trust:       trusted: supplied certificate " + B.certFile);
    expect(withCert.out).toContain("  Result: PASS");
  });

  it("exits 1 and prints MISSING with the signature file named when a listed file's detached signature is gone", async () => {
    await A.signing.signDirectory(dir, { scope: "@ta" });
    fs.rmSync(path.join(dir, "lib", "b.bin.sig"));

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(1);
    expect(run.out.split("\n")).toContain(line("MISSING", "lib/b.bin — the signature file lib/b.bin.sig is missing"));
    expect(run.out).toContain("  Result: FAIL (valid 2, untrusted 0, invalid 0, not fully signed 0, not checked 0, missing 1, unlisted 0; skipped 0)");
  });

  it("exits 1 and prints INVALID, MISSING, UNLISTED, LINK and SKIPPED lines with the counts for a directory that has changed", async () => {
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await A.signing.signDirectory(dir, { scope: "@ta" });
    fs.appendFileSync(path.join(dir, "a.bin"), Buffer.from([0]));
    fs.rmSync(path.join(dir, "lib", "b.bin"));
    fs.writeFileSync(path.join(dir, "extra.bin"), Buffer.from([0, 9, 9]));
    fs.symlinkSync(outside, path.join(dir, "ext-link"));
    fs.symlinkSync("tiny.exe", path.join(dir, "tiny.link"));

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(1);
    const lines = run.out.split("\n");
    expect(lines.some((candidate) => candidate.startsWith(line("INVALID", "a.bin — ")) && /modified/i.test(candidate))).toBe(true);
    expect(lines).toContain(line("MISSING", "lib/b.bin"));
    expect(lines).toContain(line("UNLISTED", "extra.bin — not in the manifest"));
    expect(lines).toContain(line("UNLISTED", "ext-link — not checked (link or special file)"));
    expect(lines).toContain(line("LINK", "tiny.link -> tiny.exe"));
    expect(lines).toContain(line("SKIPPED", "notes.txt — present, not signed; contents not checked"));
    expect(lines).toContain(line("VALID", "tiny.exe (Windows program; signer matches the manifest)"));
    expect(run.out).toContain("  Result: FAIL (valid 1, untrusted 0, invalid 1, not fully signed 0, not checked 0, missing 1, unlisted 2; skipped 1)");
  });

  it("prints the earlier-format wording for a version 1 manifest, with the unlisted file and the exit status 1", async () => {
    fs.rmSync(path.join(dir, "tiny.exe"));
    const entries = [];
    for (const name of ["a.bin", "lib/b.bin"]) {
      const result = await A.signing.signFile(path.join(dir, name), { scope: "@ta", detached: true });
      const sig = JSON.parse(fs.readFileSync(expectPresent(result.signaturePath, "signaturePath"), "utf-8"));
      entries.push({ path: name, signatureFile: name + ".sig", algorithm: "SHA256", signature: sig.signature });
    }
    writeManifest({
      version: 1,
      signedAt: new Date().toISOString(),
      certificate: fs.readFileSync(expectPresent(A.signing.getCertInfo("@ta"), "certificate").certPath, "utf-8"),
      certificateFingerprint: expectPresent(A.signing.getCertInfo("@ta"), "certificate").fingerprint,
      files: entries,
    });
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(1);
    expect(run.out).toMatch(/^ {2}Manifest: {4}\.signatures\.json, earlier format \(version 1\); signing the directory again writes the current one/m);
    expect(run.out.split("\n")).toContain(line("VALID", "a.bin (detached; signer matches the manifest)"));
    expect(run.out).toContain("UNLISTED         notes.txt");
  });

  it("prints the re-sign warning when a version 2 manifest records no skipped files and a text file is present", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await A.signing.signDirectory(dir, { scope: "@ta" });
    const manifest = readManifest();
    delete manifest.skipped;
    writeManifest(manifest);

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(1);
    expect(run.out.split("\n")).toContain("  Warning: this manifest does not record files that were not signed; sign the directory again to record them");
  });

  it("prints every warning, here the one for a recorded skipped file that is gone, and still exits 0", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await A.signing.signDirectory(dir, { scope: "@ta" });
    fs.rmSync(path.join(dir, "notes.txt"));

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out).toMatch(/^ {2}Warning: .*notes\.txt/m);
  });

  it("exits 1 and says the fingerprint does not match when the manifest's recorded fingerprint is wrong", async () => {
    await A.signing.signDirectory(dir, { scope: "@ta" });
    const manifest = readManifest();
    const wrong = "SHA256:" + "00".repeat(32);
    manifest.certificateFingerprint = wrong;
    writeManifest(manifest);

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(1);
    expect(run.out).toContain("(fingerprint does NOT match the manifest's recorded fingerprint " + wrong + ")");
    expect(run.out).toMatch(/^ {2}Result: FAIL/m);
  });

  it("exits 2 for a directory without a manifest", async () => {
    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(2);
    expect(run.err).toContain("No .signatures.json manifest found in " + dir);
    expect(run.out).not.toContain("Result:");
  });

  it("exits 3 for a malformed manifest, before any file result", async () => {
    await A.signing.signDirectory(dir, { scope: "@ta" });
    const manifest = readManifest();
    delete manifest.certificate;
    writeManifest(manifest);

    const run = await runVerify([dir], A.configDir, home);
    expect(run.status).toBe(3);
    expect(run.err).toMatch(/Manifest file \.signatures\.json is malformed: .+/);
    expect(run.out).not.toContain("Result:");
    expect(run.out).not.toMatch(/^ {2}VALID/m);
  });

  it("verifies a directory whose path has spaces and shell-special characters exactly", async () => {
    const odd = path.join(root, "my dir $(echo x) & 'q' ;`z`");
    fs.renameSync(dir, odd);
    await A.signing.signDirectory(odd, { scope: "@ta" });

    const run = await runVerify([odd], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out.split("\n")[0]).toBe("Verifying directory: " + odd);
    expect(run.out).toContain("  Result: PASS");
  });
});

// A file in no known program format that signFile still treats as binary (it refuses plain text, so a text file cannot carry a detached signature)
const OPAQUE_DATA = Buffer.from([0x6f, 0x70, 0x61, 0x71, 0x75, 0x65, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x00, 0xff, 0xfe, 0x0a]);

describe("signing verify <file>", () => {
  // Forms these tests fix:
  //   - a Mac program's "Slice <arch>:" labels are padded with spaces to the width of the longest label
  //     plus one space, so the states line up ("Slice x86_64: intact", "Slice arm64:  intact")
  //   - with both kinds of signature, "Form:" reads "<program form> (embedded) and detached (<file name>.sig)"
  //     and the sub-blocks begin with "  Signature embedded:" and "  Signature detached:"; the lines in
  //     them are the same lines as the main report, indented by four spaces
  //   - the "Warning:" for a file with both kinds contains the word "both"
  //   - the two refusals print "<abs> is a signature file; verify <abs without .sig> instead" and
  //     "<abs> is a directory manifest; verify the directory <abs dir> instead"
  const NOT_CHECKED_LINE = "  Not checked: certificate chains, revocation, signing time, acceptance by the platform's own verifier";
  const genuine = (name: string): string => path.join(__dirname, "fixtures", "binaries", "genuine", name);
  let dir: string;

  function copyTo(name: string): string {
    const dest = path.join(dir, name);
    fs.copyFileSync(name === "tiny.exe" ? path.join(__dirname, "fixtures", "binaries", name) : genuine(name), dest);
    return dest;
  }

  function dayOf(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  function invertAt0x16ea(file: string): void {
    const bytes = fs.readFileSync(file);
    bytes[0x16ea] ^= 0xff;
    fs.writeFileSync(file, bytes);
  }

  beforeEach(() => {
    dir = tempDir("cli-file-report-");
  });

  describe("exit status per outcome", () => {
    it("exits 0 for a valid file", async () => {
      const file = copyTo("tiny-macho-arm64");
      await A.signing.signFileMachO(file, "@ta");
      expect((await runVerify([file], A.configDir, home)).status).toBe(0);
    });

    it("exits 4 for a file that is intact but not trusted", async () => {
      expect((await runVerify([signedInB], A.configDir, home)).status).toBe(4);
    });

    it("exits 1 for an invalid file", async () => {
      const file = copyTo("tiny-macho-arm64");
      await A.signing.signFileMachO(file, "@ta");
      invertAt0x16ea(file);
      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(1);
      expect(run.out).toContain("Verification: INVALID ✗");
    });

    it("exits 1 for a universal program with an unsigned slice", async () => {
      const signed = copyTo("tiny-macho-arm64");
      await A.signing.signFileMachO(signed, "@ta");
      const file = path.join(dir, "partly-signed");
      fs.writeFileSync(
        file,
        makeUniversal([
          { cpuType: 0x0100000c, cpuSubtype: 0, bytes: fs.readFileSync(signed) },
          { cpuType: 0x01000007, cpuSubtype: 0x80000003, bytes: fs.readFileSync(genuine("tiny-macho-x86_64")) },
        ])
      );
      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(1);
      expect(run.out).toContain("Verification: NOT FULLY SIGNED ✗");
      expect(run.out).toMatch(/^ {2}Slice x86_64: +unsigned$/m);
    });

    it("exits 1 for an installer whose signature is not checked, printing the headline and the reason", async () => {
      const run = await runVerify([copyTo("tiny-osslsig-dse.msi")], A.configDir, home);
      expect(run.status).toBe(1);
      expect(run.out).toContain("Verification: SIGNATURE NOT CHECKED ✗");
      expect(run.out).toMatch(/^ {2}Integrity: {3}not checked: .*extended signature stream/m);
      expect(run.out).toContain("  Trust:       not applicable");
    });

    it("exits 4 for an ad-hoc signed program, printing that the signature has no signer", async () => {
      const run = await runVerify([copyTo("tiny-macho-arm64-adhoc")], A.configDir, home);
      expect(run.status).toBe(4);
      expect(run.out).toContain("Verification: INTACT, NOT TRUSTED ✗");
      expect(run.out).toContain("  Trust:       not trusted: the signature has no signer (ad-hoc)");
      expect(run.out).toMatch(/^ {2}Slice arm64: +ad-hoc \(no signer\)$/m);
      expect(run.out).not.toContain("Signer:");
    });

    it("exits 1 for a file with no signature", async () => {
      const run = await runVerify([copyTo("tiny-macho-arm64")], A.configDir, home);
      expect(run.status).toBe(1);
      expect(run.out).toContain("Verification: NO SIGNATURE");
    });

    it("exits 2 for a path that does not exist", async () => {
      const missing = path.join(dir, "absent.bin");
      const run = await runVerify([missing], A.configDir, home);
      expect(run.status).toBe(2);
      expect(run.err).toContain("Error: File not found: " + missing);
    });

    it("exits 3 when no path is given", async () => {
      const run = await runVerify([], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Error: <path> is required.");
      expect(run.err).toContain(USAGE);
    });

    it("exits 3 for a .sig path, naming the file to verify instead, and prints no report", async () => {
      const file = path.join(dir, "opaque.dat");
      fs.writeFileSync(file, OPAQUE_DATA);
      await A.signing.signFile(file, { scope: "@ta", detached: true });
      const run = await runVerify([file + ".sig"], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Error: " + file + ".sig is a signature file; verify " + file + " instead");
      expect(run.out).not.toContain("Verification:");
    });

    it("exits 3 for .signatures.json, naming the directory to verify instead, and prints no report", async () => {
      const manifest = path.join(dir, ".signatures.json");
      fs.writeFileSync(manifest, "{}");
      const run = await runVerify([manifest], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Error: " + manifest + " is a directory manifest; verify the directory " + dir + " instead");
      expect(run.out).not.toContain("Verification:");
    });
  });

  describe("report lines", () => {
    it("prints the labelled lines in order for a valid universal Mac program, one line per slice", async () => {
      const file = copyTo("tiny-macho-universal");
      await A.signing.signFileMachO(file, "@ta");
      const cert = expectPresent(A.signing.getCertInfo("@ta"), "certificate");

      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(0);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: VALID ✓");
      expect(lines[1]).toBe("  File:        " + file);
      expect(lines[2]).toBe("  Form:        Mac program (embedded, 2 slices)");
      expect(lines[3]).toMatch(/^ {2}Integrity: {3}intact \(.+\)$/);
      expect(lines[4]).toBe("  Trust:       trusted: certificate of scope @ta");
      expect(lines[5]).toBe("  Signer:      " + A.signing._formatSubject(cert.subject));
      expect(lines[6]).toBe("  Issuer:      " + cert.issuer);
      expect(lines[7]).toBe("  Fingerprint: " + cert.fingerprint);
      expect(lines[8]).toBe("  Valid:       " + dayOf(cert.notBefore) + " to " + dayOf(cert.notAfter));
      expect(lines[9]).toMatch(/^ {2}Slice x86_64: intact \(\d+ pages\)$/);
      expect(lines[10]).toMatch(/^ {2}Slice arm64: {2}intact \(\d+ pages\)$/);
      expect(lines[lines.length - 1]).toBe(NOT_CHECKED_LINE);
      expect(run.out).not.toContain("Warning:");
    });

    it("prints Integrity, Fingerprint and Valid for an invalid file whose signer was read, and the reason", async () => {
      const file = copyTo("tiny-macho-arm64");
      await A.signing.signFileMachO(file, "@ta");
      invertAt0x16ea(file);
      const cert = expectPresent(A.signing.getCertInfo("@ta"), "certificate");

      const run = await runVerify([file], A.configDir, home);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: INVALID ✗");
      expect(lines.some((line) => /^ {2}Integrity: {3}invalid: .*slice arm64: page 1/.test(line))).toBe(true);
      expect(lines).toContain("  Fingerprint: " + cert.fingerprint);
      expect(lines).toContain("  Valid:       " + dayOf(cert.notBefore) + " to " + dayOf(cert.notAfter));
      expect(lines.some((line) => /^ {2}Slice arm64: +invalid: /.test(line))).toBe(true);
      expect(lines[lines.length - 1]).toBe(NOT_CHECKED_LINE);
    });

    it("prints the untrusted headline with the signer lines and the trust sentence", async () => {
      const run = await runVerify([signedInB], A.configDir, home);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: INTACT, NOT TRUSTED ✗");
      expect(lines).toContain("  Trust:       not trusted: signer certificate is not one of the trusted certificates");
      expect(lines.some((line) => /^ {2}Signer: {6}CN=/.test(line))).toBe(true);
      expect(lines.some((line) => line.startsWith("  Valid:       "))).toBe(true);
    });

    it("prints no signer lines for a file with no signature, and not applicable for trust", async () => {
      const file = copyTo("tiny-macho-arm64");
      const run = await runVerify([file], A.configDir, home);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: NO SIGNATURE");
      expect(lines[1]).toBe("  File:        " + file);
      expect(lines.some((line) => /^ {2}Integrity: {3}no signature: .+/.test(line))).toBe(true);
      expect(lines).toContain("  Trust:       not applicable");
      expect(run.out).not.toContain("Signer:");
      expect(lines[lines.length - 1]).toBe(NOT_CHECKED_LINE);
    });

    it("prints a detached file's form with its signature file name", async () => {
      const file = path.join(dir, "opaque.dat");
      fs.writeFileSync(file, OPAQUE_DATA);
      await A.signing.signFile(file, { scope: "@ta", detached: true });
      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(0);
      expect(run.out).toMatch(/^ {2}Form: {8}detached \(.*opaque\.dat\.sig\)$/m);
    });

    it("prints every warning of the result, here the one for a file with both kinds of signature", async () => {
      const file = copyTo("tiny.exe");
      await A.signing.signFile(file, { scope: "@ta" });
      await A.signing.signFile(file, { scope: "@ta", detached: true });
      const run = await runVerify([file], A.configDir, home);
      const lines = run.out.split("\n");
      const result = await A.signing.verifyFile(file);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.warnings.some((warning) => /both/i.test(warning))).toBe(true);
      for (const warning of result.warnings) {
        expect(lines).toContain("  Warning: " + warning);
      }
    });
  });

  describe("a file with both kinds of signature", () => {
    it("prints both forms and a sub-block per kind when both are intact and trusted", async () => {
      const file = copyTo("tiny.exe");
      await A.signing.signFile(file, { scope: "@ta" });
      await A.signing.signFile(file, { scope: "@ta", detached: true });

      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(0);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: VALID ✓");
      expect(lines.some((line) => /^ {2}Form: {8}Windows program \(embedded\) and detached \(.*tiny\.exe\.sig\)$/.test(line))).toBe(true);
      const embedded = lines.indexOf("  Signature embedded:");
      const detached = lines.indexOf("  Signature detached:");
      expect(embedded).toBeGreaterThan(0);
      expect(detached).toBeGreaterThan(embedded);
      for (const block of [lines.slice(embedded + 1, detached), lines.slice(detached + 1)]) {
        expect(block.some((line) => /^ {4}Integrity: {3}intact/.test(line))).toBe(true);
        expect(block).toContain("    Trust:       trusted: certificate of scope @ta");
        expect(block.some((line) => line.startsWith("    Signer:      "))).toBe(true);
      }
    });

    it("shows the worse headline and the failing kind when the detached signature is stale", async () => {
      const file = copyTo("tiny.exe");
      await A.signing.signFile(file, { scope: "@ta", detached: true });
      const kept = fs.readFileSync(file + ".sig");
      await A.signing.signFile(file, { scope: "@ta" });
      fs.writeFileSync(file + ".sig", kept);

      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(1);
      const lines = run.out.split("\n");
      expect(lines[0]).toBe("Verification: INVALID ✗");
      const embedded = lines.indexOf("  Signature embedded:");
      const detached = lines.indexOf("  Signature detached:");
      expect(embedded).toBeGreaterThan(0);
      expect(detached).toBeGreaterThan(embedded);
      expect(lines.slice(embedded + 1, detached).some((line) => /^ {4}Integrity: {3}intact/.test(line))).toBe(true);
      expect(lines.slice(detached + 1).some((line) => /^ {4}Integrity: {3}invalid: .*stale detached signature/i.test(line))).toBe(true);
    });

    it("shows the untrusted headline when the detached signature is from another scope, exiting 4", async () => {
      const file = copyTo("tiny.exe");
      await A.signing.signFile(file, { scope: "@ta" });
      await B.signing.signFile(file, { scope: "@tb", detached: true });

      const run = await runVerify([file], A.configDir, home);
      expect(run.status).toBe(4);
      expect(run.out.split("\n")[0]).toBe("Verification: INTACT, NOT TRUSTED ✗");
    });
  });

  it("verifies a path with spaces and shell-special characters exactly", async () => {
    const odd = path.join(dir, "my prog $(echo x) & 'q' ;`z` *.bin");
    fs.copyFileSync(genuine("tiny-macho-arm64"), odd);
    await A.signing.signFileMachO(odd, "@ta");

    const run = await runVerify([odd], A.configDir, home);
    expect(run.status).toBe(0);
    expect(run.out.split("\n")[1]).toBe("  File:        " + odd);
  });
});

// The help text, run through runTheSeed with a scratch configuration directory and a scratch HOME.
// Form these tests fix:
//   - "signing help" carries, as notes after the subcommand list, the paragraphs below; they are compared
//     with whitespace collapsed, so only the words and their order are fixed
//   - the verify subcommand's own help shows "the-seed signing verify [--cert <file>]... <path>"
describe("signing help", () => {
  async function runHelp(args: string[]): Promise<string> {
    const run = await runTheSeed(args);
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    return run.stdout;
  }

  it("describes verify", async () => {
    const text = await runHelp(["signing", "help"]);
    const lines = text.split("\n");
    expect(lines.some((line) => line.includes("verify") && line.includes("[--cert <file>]..."))).toBe(true);
    expect(await runHelp(["signing", "verify", "--help"])).toContain(USAGE);

    const collapsed = text.replace(/\s+/g, " ");
    const paragraph =
      "verify checks that a file is unchanged since it was signed and that its signer " +
      "is one of the certificates of your configured scopes (or of the files named with " +
      "--cert). Certificate chains, revocation, signing time and acceptance " +
      "by the platform's own verifier are not checked.";
    expect(collapsed).toContain(paragraph);
  });

  // Choice: the paragraph is compared with whitespace collapsed, so only its words and their order are fixed,
  // and it must come after the verify paragraph.
  it("says what sign writes and what it was checked with", async () => {
    const collapsed = (await runHelp(["signing", "help"])).replace(/\s+/g, " ");
    const verifyEnd = "by the platform's own verifier are not checked.";
    const paragraph =
      "sign writes standard signature containers (signed attributes, the signer's " +
      "certificate). Checked with independent tools, the signer's certificate given " +
      "as the trusted root: Windows programs and installers pass osslsigncode; each " +
      "slice of a Mac program passes openssl's signed-data check over its code " +
      "directory. Not checked with the platforms' own tools (signtool, WinVerifyTrust, " +
      "the Windows Installer service, codesign, Gatekeeper), which may still refuse " +
      "the certificate. Files signed by earlier versions should be signed again.";
    expect(collapsed).toContain(paragraph);
    expect(collapsed.indexOf(verifyEnd)).toBeGreaterThanOrEqual(0);
    expect(collapsed.indexOf(paragraph)).toBeGreaterThan(collapsed.indexOf(verifyEnd));
  });
});

// `sign` with a scope key the tool cannot use, run through runTheSeed with a scratch configuration and HOME.
// Choices: the configuration has one scope so no prompt appears; the file is a copy of the arm64 Mac sample
// whose modification time is first set to a fixed past date; the message is the key check's own, after "Error: ".
describe("signing sign with an unsupported scope key", () => {
  it("prints the message on stderr, exits 3 and leaves the file byte-for-byte unchanged with the same modification time", async () => {
    const config = await makeConfiguration("@tk");
    replaceScopeKey(config.configDir, "@tk", "rsa2048");
    const file = path.join(tempDir("cli-sign-file-"), "tiny-macho-arm64");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
    const past = new Date("2020-01-01T00:00:00Z");
    fs.utimesSync(file, past, past);
    const before = fs.readFileSync(file);
    const mtimeBefore = fs.statSync(file).mtimeMs;

    const run = await runSign([file], config.configDir, home);

    expect(run.status).toBe(3);
    expect(run.err).toBe("Error: Cannot sign with scope '@tk': its key is RSA (2048-bit); only ECDSA P-256 keys are supported. No file was changed.");
    expect(run.out).not.toContain("Signed:");
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtimeBefore);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["tiny-macho-arm64"]);
  });
});

// Choices: the commands are run through a command runner loaded in a module registry in which the native component
// is unavailable; files are signed with the component first where a signed file is needed; a Linux program is a copy of /bin/true.
describe("signing without the native component", () => {
  type CommandModule = typeof import("./helpers/RunCli");
  type ComponentModule = typeof import("../src/NativeComponent");

  let commands: CommandModule;
  let component: ComponentModule;
  let dir: string;

  async function runWith(module: CommandModule, command: string, args: string[]): Promise<CommandRun> {
    const run = await module.runTheSeed(["signing", command, ...args], { home, configDir: A.configDir });
    return { status: run.status, out: lines(run.stdout), err: lines(run.stderr) };
  }

  beforeEach(() => {
    dir = tempDir("cli-absent-");
    const loaded = withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      commands: require("./helpers/RunCli") as CommandModule,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the message comes from the same registry
      component: require("../src/NativeComponent") as ComponentModule,
    }));
    commands = loaded.commands;
    component = loaded.component;
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
  });

  it("sign refuses a Windows program: the message alone on standard error, exit 3, nothing changed", async () => {
    const file = path.join(dir, "tiny.exe");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), file);
    const before = fileDigest(file);

    const run = await runWith(commands, "sign", [file]);

    expect(run.status).toBe(3);
    expect(run.err).toBe("Error: " + component.nativeComponentMessage());
    expect(run.out).not.toContain("Signed:");
    expect(fileDigest(file)).toBe(before);
    expect(fs.existsSync(file + ".sig")).toBe(false);
  });

  it("verify reports a signed Windows program as not checked, with the message as the reason", async () => {
    const file = path.join(dir, "tiny.exe");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), file);
    await A.signing.signFile(file, { scope: "@ta" });

    const run = await runWith(commands, "verify", [file]);

    expect(run.status).toBe(1);
    expect(run.out).toContain("Verification: SIGNATURE NOT CHECKED ✗");
    expect(run.out).toContain(component.nativeComponentMessage());
  });

  it("sign still signs a Linux program with a detached signature", async () => {
    const file = path.join(dir, "linux-program");
    fs.copyFileSync("/bin/true", file);

    const run = await runWith(commands, "sign", [file]);

    expect(run.status).toBe(0);
    expect(run.out).toContain("Signed: " + file);
    expect(fs.existsSync(file + ".sig")).toBe(true);
  });
});

// The five subcommands that use a certificate choose their scope with --scope. Choices: the configuration has
// the scopes @a and @b; where a case needs certificates they are created in the scratch configuration
// directory (@a's author is "Signer @a"); the file to sign is a copy of the arm64 Mac sample; "nothing changed"
// is a snapshot of the configuration directory, the working directory and the target's directory.
describe("signing --scope", () => {
  interface TwoScopes {
    configDir: string;
    signing: Signing;
    cwd: string;
  }

  async function twoScopes(withCerts: boolean): Promise<TwoScopes> {
    const configDir = tempDir("cli-scope-config-");
    const scopes: Record<string, { author: { name: string; email: string; url: string } }> = {};
    for (const scope of ["@a", "@b"]) {
      scopes[scope] = { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } };
    }
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
    const signing = new Signing(configDir);
    if (withCerts) {
      await signing.createCert({ validityDays: 365, scope: "@a" });
      await signing.createCert({ validityDays: 365, scope: "@b" });
    }
    return { configDir, signing, cwd: tempDir("cli-scope-cwd-") };
  }

  function sampleCopy(): string {
    const file = path.join(tempDir("cli-scope-file-"), "tiny-macho-arm64");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "genuine", "tiny-macho-arm64"), file);
    return file;
  }

  // A certificate and key made for a scope of another configuration, for import-cert.
  async function externalPair(): Promise<{ cert: string; key: string }> {
    const configDir = tempDir("cli-scope-external-");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ prefix: configDir, scopes: { "@ext": { author: { name: "External", email: "e@example.com", url: "" } } } }),
    );
    await new Signing(configDir).createCert({ validityDays: 365, scope: "@ext" });
    return {
      cert: path.join(configDir, "signing", "@ext", "cert.pem"),
      key: path.join(configDir, "signing", "@ext", "key.pem"),
    };
  }

  const certFor = (configDir: string, scope: string) => path.join(configDir, "signing", scope, "cert.pem");

  describe("a configured scope is used without a prompt", () => {
    it("create-cert --scope @a creates the certificate for @a only", async () => {
      const t = await twoScopes(false);
      const run = await runTheSeed(["signing", "create-cert", "--scope", "@a"], { home, configDir: t.configDir, cwd: t.cwd });
      expect(run.status).toBe(0);
      expect(run.prompts).toEqual([]);
      expect(fs.existsSync(certFor(t.configDir, "@a"))).toBe(true);
      expect(fs.existsSync(certFor(t.configDir, "@b"))).toBe(false);
    });

    it("import-cert --scope @a imports into @a only", async () => {
      const t = await twoScopes(false);
      const pair = await externalPair();
      const run = await runTheSeed(["signing", "import-cert", "--cert", pair.cert, "--key", pair.key, "--scope", "@a"], {
        home,
        configDir: t.configDir,
        cwd: t.cwd,
      });
      expect(run.status).toBe(0);
      expect(run.prompts).toEqual([]);
      expect(fs.readFileSync(certFor(t.configDir, "@a"), "utf-8")).toBe(fs.readFileSync(pair.cert, "utf-8"));
      expect(fs.existsSync(certFor(t.configDir, "@b"))).toBe(false);
    });

    it("sign <file> --scope a (without the @) signs with @a's certificate", async () => {
      const t = await twoScopes(false);
      await t.signing.createCert({ validityDays: 365, scope: "@a" });
      const file = sampleCopy();
      const before = fileDigest(file);
      const run = await runTheSeed(["signing", "sign", file, "--scope", "a"], { home, configDir: t.configDir, cwd: t.cwd });
      expect(run.status).toBe(0);
      expect(run.prompts).toEqual([]);
      expect(run.stdout).toContain("Signed: " + file);
      expect(fileDigest(file)).not.toBe(before);
    });

    it("cert-info --scope @a shows @a's certificate and not @b's", async () => {
      const t = await twoScopes(true);
      const run = await runTheSeed(["signing", "cert-info", "--scope", "@a"], { home, configDir: t.configDir, cwd: t.cwd });
      expect(run.status).toBe(0);
      expect(run.prompts).toEqual([]);
      expect(run.stdout).toContain("Signer @a");
      expect(run.stdout).not.toContain("Signer @b");
    });

    it("export-cert --output <file> --scope @a writes @a's certificate", async () => {
      const t = await twoScopes(true);
      const output = path.join(t.cwd, "out.pem");
      const run = await runTheSeed(["signing", "export-cert", "--output", output, "--scope", "@a"], {
        home,
        configDir: t.configDir,
        cwd: t.cwd,
      });
      expect(run.status).toBe(0);
      expect(run.prompts).toEqual([]);
      expect(fs.readFileSync(output, "utf-8")).toBe(fs.readFileSync(certFor(t.configDir, "@a"), "utf-8"));
    });
  });

  // Each row builds the arguments from the working directory, a sample file and an external pair.
  type Row = [string, (cwd: string, file: string, pair: { cert: string; key: string }) => string[]];
  const rows: Row[] = [
    ["create-cert", () => ["create-cert"]],
    ["import-cert", (_cwd, _file, pair) => ["import-cert", "--cert", pair.cert, "--key", pair.key]],
    ["sign", (_cwd, file) => ["sign", file]],
    ["cert-info", () => ["cert-info"]],
    ["export-cert", (cwd) => ["export-cert", "--output", path.join(cwd, "out.pem")]],
  ];

  describe.each(rows)("%s", (name, build) => {
    it("--scope @nope is refused with status 2 before any work, naming it and listing the configured scopes", async () => {
      const t = await twoScopes(true);
      const file = sampleCopy();
      const pair = await externalPair();
      const dirs = [t.configDir, t.cwd, path.dirname(file)];
      const before = dirs.map((dir) => snapshotTree(dir));
      const run = await runTheSeed(["signing", ...build(t.cwd, file, pair), "--scope", "@nope"], {
        home,
        configDir: t.configDir,
        cwd: t.cwd,
      });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("@nope");
      expect(run.stderr).toContain("@a, @b");
      expect(run.stdout).toBe("");
      expect(run.prompts).toEqual([]);
      expect(dirs.map((dir) => snapshotTree(dir))).toEqual(before);
    });

    it("two scopes, not interactive and no --scope is a usage error naming --scope, with no prompt", async () => {
      const t = await twoScopes(true);
      const file = sampleCopy();
      const pair = await externalPair();
      const dirs = [t.configDir, t.cwd, path.dirname(file)];
      const before = dirs.map((dir) => snapshotTree(dir));
      const run = await runTheSeed(["signing", ...build(t.cwd, file, pair)], {
        home,
        configDir: t.configDir,
        cwd: t.cwd,
        interactive: false,
      });
      expect(run.status).toBe(3);
      expect(run.stderr).toContain("--scope");
      expect(run.prompts).toEqual([]);
      expect(dirs.map((dir) => snapshotTree(dir))).toEqual(before);
      expect(name.length).toBeGreaterThan(0);
    });
  });

  it("create-cert --scope @a with a certificate present, not interactive and no --force is a usage error naming --force", async () => {
    const t = await twoScopes(true);
    const before = [snapshotTree(t.configDir), snapshotTree(t.cwd)];
    const run = await runTheSeed(["signing", "create-cert", "--scope", "@a"], {
      home,
      configDir: t.configDir,
      cwd: t.cwd,
      interactive: false,
    });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("--force");
    expect(run.prompts).toEqual([]);
    expect([snapshotTree(t.configDir), snapshotTree(t.cwd)]).toEqual(before);
  });

  it("import-cert --scope @a with a certificate present, not interactive and no --force is a usage error naming --force", async () => {
    const t = await twoScopes(true);
    const pair = await externalPair();
    const before = [snapshotTree(t.configDir), snapshotTree(t.cwd)];
    const run = await runTheSeed(["signing", "import-cert", "--cert", pair.cert, "--key", pair.key, "--scope", "@a"], {
      home,
      configDir: t.configDir,
      cwd: t.cwd,
      interactive: false,
    });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("--force");
    expect([snapshotTree(t.configDir), snapshotTree(t.cwd)]).toEqual(before);
  });

  it("sign with no path is a usage error saying the path is required", async () => {
    const t = await twoScopes(true);
    const run = await runTheSeed(["signing", "sign"], { home, configDir: t.configDir, cwd: t.cwd, interactive: false });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("<path> is required.");
    expect(run.prompts).toEqual([]);
  });

  it("sign --forse <file> is a usage error naming the option and leaves the file unchanged", async () => {
    const t = await twoScopes(true);
    const file = sampleCopy();
    const before = fileDigest(file);
    const run = await runTheSeed(["signing", "sign", "--forse", file, "--scope", "@a"], { home, configDir: t.configDir, cwd: t.cwd });
    expect(run.status).toBe(3);
    expect(run.stderr).toContain("--forse");
    expect(fileDigest(file)).toBe(before);
  });
});
