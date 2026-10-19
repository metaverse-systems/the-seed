import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { runVerify } from "./helpers/Command";

// The verify command, run through runCli with a scratch configuration directory and a scratch HOME.
// Two configurations are used: A (scope @ta) and B (scope @tb). The command's status is the first
// status passed to process.exit, or 0 when it never calls it. Usage errors are written to stderr
// as "Error: <text>"; wherever the contract leaves the wording open, the tests below fix it:
//   - a --cert without a value:  "Error: --cert needs a file"  followed by the usage line
//   - an unknown option:         "Error: Unknown option <option>"  followed by the usage line
//   - the usage line:            "Usage: the-seed signing verify [--cert <file>]... <path>"

const USAGE = "Usage: the-seed signing verify [--cert <file>]... <path>";

const created: string[] = [];

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
    expect(run.err).toContain("Missing path argument. " + USAGE);
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
      expect(run.err).toContain("--cert needs a file");
      expect(run.err + run.out).toContain(USAGE);
      expect(run.out).not.toContain("Verification:");
    });

    it("exits 3 with the usage line for an unknown option", async () => {
      const run = await runVerify(["--bogus", signedInB], A.configDir, home);
      expect(run.status).toBe(3);
      expect(run.err).toContain("Unknown option --bogus");
      expect(run.err + run.out).toContain(USAGE);
      expect(run.out).not.toContain("Verification:");
    });
  });
});
