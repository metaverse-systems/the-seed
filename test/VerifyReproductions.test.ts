import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { expectPresent } from "./helpers/Assert";
import { runVerify } from "./helpers/Command";
import { makeUniversal } from "./helpers/Universal";

// Reproductions of verification faults, written against Signing.verifyFile. Two configuration
// directories are used: A (scope @ta) and B (scope @tb), each with its own certificate. Every file
// and directory is created under os.tmpdir() and removed afterwards; nothing reads the real home.

const created: string[] = [];
let savedHome: string | undefined;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

function genuinePath(name: string): string {
  return path.join(__dirname, "fixtures", "binaries", "genuine", name);
}

function copyGenuine(name: string, destDir: string): string {
  const dest = path.join(destDir, name);
  fs.copyFileSync(genuinePath(name), dest);
  return dest;
}

/** Creates a configuration directory with one scope and a certificate for it. */
async function makeConfiguration(prefix: string, scope: string): Promise<{ signing: Signing; configDir: string; scope: string }> {
  const configDir = tempDir(prefix);
  const scopes = { [scope]: { author: { name: "Signer " + scope, email: "signer@example.com", url: "" } } };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
  const signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope });
  return { signing, configDir, scope };
}

/** The addon's slice table of a file, for placing a change inside one slice. */
function sliceTable(file: string): Array<{ cpuType: number; offset: number; size: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- the native addon has no type declarations
  const addon = require("../native/build/Release/dependency_lister.node");
  return addon.machoListSlices(file);
}

function invertByteAt(file: string, position: number): void {
  const bytes = fs.readFileSync(file);
  bytes[position] ^= 0xff;
  fs.writeFileSync(file, bytes);
}

let A: { signing: Signing; configDir: string; scope: string };
let B: { signing: Signing; configDir: string; scope: string };

beforeAll(async () => {
  savedHome = process.env.HOME;
  process.env.HOME = tempDir("reproductions-home-");
  A = await makeConfiguration("reproductions-a-", "@ta");
  B = await makeConfiguration("reproductions-b-", "@tb");
});

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = savedHome;
  }
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup", () => {
  it("has a certificate for each configuration, and the two are different", async () => {
    expect(A.signing.hasCert("@ta")).toBe(true);
    expect(B.signing.hasCert("@tb")).toBe(true);
    const exported = path.join(tempDir("reproductions-export-"), "b.pem");
    await B.signing.exportCert(exported, "@tb");
    expect(fs.readFileSync(exported, "utf-8")).toContain("BEGIN CERTIFICATE");
    expect(expectPresent(A.signing.getCertInfo("@ta"), "A").fingerprint).not.toBe(expectPresent(B.signing.getCertInfo("@tb"), "B").fingerprint);
  });
});

describe("Mac program", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir("reproductions-mac-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a byte changed at 0x16ea of the signed arm64 program is invalid, naming slice arm64 and page 1", async () => {
    const file = copyGenuine("tiny-macho-arm64", dir);
    await A.signing.signFileMachO(file, "@ta");
    expect((await A.signing.verifyFile(file)).status).toBe("VALID");

    // 0x16ea = 5866 lies in the second 4,096-byte page (page 1) of the file
    invertByteAt(file, 0x16ea);

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("INVALID");
    expect(result.integrity.state).toBe("invalid");
    expect(result.integrity.reason).toMatch(/slice arm64: page 1/);
    expect(expectPresent(result.slices, "slices")[0].state).toBe("invalid");
  });

  it("an unchanged signed program is valid and shows its signer and each slice", async () => {
    const fingerprint = expectPresent(A.signing.getCertInfo("@ta"), "A").fingerprint;
    for (const name of ["tiny-macho-arm64", "tiny-macho-universal"]) {
      const file = copyGenuine(name, dir);
      await A.signing.signFileMachO(file, "@ta");

      const result = await A.signing.verifyFile(file);
      expect(result.status).toBe("VALID");
      expect(result.form).toBe("mac-program");
      expect(result.integrity.state).toBe("intact");
      expect(expectPresent(result.signer, "signer").fingerprint).toBe(fingerprint);
      expect(result.trust.state).toBe("trusted");
      expect(result.trust.anchor).toMatchObject({ source: "scope", scope: "@ta" });
      const slices = expectPresent(result.slices, "slices");
      expect(slices).toHaveLength(name === "tiny-macho-universal" ? 2 : 1);
      for (const slice of slices) {
        expect(slice.state).toBe("intact");
      }
    }
  });

  it("a byte changed in the second slice of the universal program is invalid, naming arm64, and the x86_64 slice is reported intact", async () => {
    const file = copyGenuine("tiny-macho-universal", dir);
    await A.signing.signFileMachO(file, "@ta");
    const table = sliceTable(file);
    expect(table).toHaveLength(2);
    // The second table entry is the arm64 slice; change a byte in its page 1
    expect(table[1].cpuType).toBe(0x0100000c);
    invertByteAt(file, table[1].offset + 5000);

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("INVALID");
    expect(result.integrity.reason).toMatch(/slice arm64: page 1/);
    const slices = expectPresent(result.slices, "slices");
    expect(slices.map((slice) => slice.arch)).toEqual(["x86_64", "arm64"]);
    expect(slices[0].state).toBe("intact");
    expect(slices[1].state).toBe("invalid");
  });

  it("a universal program with one signed and one unsigned slice is not fully signed, naming the unsigned slice", async () => {
    const signed = copyGenuine("tiny-macho-arm64", dir);
    await A.signing.signFileMachO(signed, "@ta");
    const unsigned = fs.readFileSync(genuinePath("tiny-macho-x86_64"));
    const file = path.join(dir, "partly-signed");
    fs.writeFileSync(
      file,
      makeUniversal([
        { cpuType: 0x0100000c, cpuSubtype: 0, bytes: fs.readFileSync(signed) },
        { cpuType: 0x01000007, cpuSubtype: 0x80000003, bytes: unsigned },
      ])
    );

    const result = await A.signing.verifyFile(file);
    expect(result.status).toBe("NOT_FULLY_SIGNED");
    expect(result.status).not.toBe("NOT_FOUND");
    expect(result.reason).toMatch(/x86_64/);
    expect(result.integrity.unsignedOnly).toEqual(["x86_64"]);
    const slices = expectPresent(result.slices, "slices");
    expect(slices.map((slice) => [slice.arch, slice.state])).toEqual([
      ["arm64", "intact"],
      ["x86_64", "unsigned"],
    ]);
  });
});

describe("cross-signer", () => {
  const UNTRUSTED_SENTENCE = "signer certificate is not one of the trusted certificates";
  let dir: string;
  let bCertFile: string;

  beforeAll(async () => {
    bCertFile = path.join(tempDir("reproductions-bcert-"), "b.pem");
    await B.signing.exportCert(bCertFile, "@tb");
  });

  beforeEach(() => {
    dir = tempDir("reproductions-cross-");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Signs `file` in B (detached when asked), then checks it from A, from A with B's certificate supplied, and from B. */
  async function expectCrossSignerOutcomes(file: string, form: string, detached: boolean): Promise<void> {
    await B.signing.signFile(file, { scope: "@tb", detached });
    const bFingerprint = expectPresent(B.signing.getCertInfo("@tb"), "B").fingerprint;

    const fromA = await A.signing.verifyFile(file);
    expect(fromA.status).toBe("UNTRUSTED");
    expect(fromA.form).toBe(form);
    expect(fromA.integrity.state).toBe("intact");
    expect(fromA.trust.state).toBe("untrusted");
    expect(fromA.trust.reason).toBe("unknown-signer");
    expect(fromA.trust.message).toContain(UNTRUSTED_SENTENCE);
    expect(fromA.reason).toContain(UNTRUSTED_SENTENCE);
    expect(expectPresent(fromA.signer, "signer").fingerprint).toBe(bFingerprint);

    const supplied = await A.signing.verifyFile(file, { trust: A.signing.loadTrust([bCertFile]) });
    expect(supplied.status).toBe("VALID");
    expect(supplied.trust.state).toBe("trusted");
    expect(supplied.trust.anchor?.source).toBe("supplied");

    const fromB = await B.signing.verifyFile(file);
    expect(fromB.status).toBe("VALID");
    expect(fromB.trust.anchor).toMatchObject({ source: "scope", scope: "@tb" });
    expect(expectPresent(fromB.signer, "signer").fingerprint).toBe(bFingerprint);
  }

  it("detached: signed in B, verified in A is intact but not trusted; in A with B's certificate supplied it is valid; in B it is valid", async () => {
    const file = path.join(dir, "tiny.exe");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), file);
    await expectCrossSignerOutcomes(file, "detached", true);
  });

  it("Windows program: signed in B, verified in A is intact but not trusted; in A with B's certificate supplied it is valid; in B it is valid", async () => {
    const file = path.join(dir, "tiny.exe");
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), file);
    await expectCrossSignerOutcomes(file, "windows-program", false);
  });

  it("installer: signed in B, verified in A is intact but not trusted; in A with B's certificate supplied it is valid; in B it is valid", async () => {
    await expectCrossSignerOutcomes(copyGenuine("tiny.msi", dir), "installer", false);
  });

  it("Mac program: signed in B, verified in A is intact but not trusted; in A with B's certificate supplied it is valid; in B it is valid", async () => {
    await expectCrossSignerOutcomes(copyGenuine("tiny-macho-arm64", dir), "mac-program", false);
  });

  it("the command exits 4 for an intact file signed in B and 0 with --cert <B's certificate>", async () => {
    const file = copyGenuine("tiny-macho-arm64", dir);
    await B.signing.signFileMachO(file, "@tb");
    const home = tempDir("reproductions-command-home-");

    const untrusted = await runVerify([file], A.configDir, home);
    expect(untrusted.status).toBe(4);
    expect(untrusted.out).toContain("Verification: INTACT, NOT TRUSTED");

    const trusted = await runVerify(["--cert", bCertFile, file], A.configDir, home);
    expect(trusted.status).toBe(0);
    expect(trusted.out).toContain("Verification: VALID");

    const fromB = await runVerify([file], B.configDir, home);
    expect(fromB.status).toBe(0);
  });

  it("a file signed in A verified with A's scopes but --cert <B's certificate> supplied is untrusted: supplied certificates replace the defaults", async () => {
    const file = copyGenuine("tiny-macho-arm64", dir);
    await A.signing.signFileMachO(file, "@ta");
    expect((await A.signing.verifyFile(file)).status).toBe("VALID");

    const result = await A.signing.verifyFile(file, { trust: A.signing.loadTrust([bCertFile]) });
    expect(result.status).toBe("UNTRUSTED");
    expect(result.integrity.state).toBe("intact");
    expect(result.trust.reason).toBe("unknown-signer");

    const command = await runVerify(["--cert", bCertFile, file], A.configDir, tempDir("reproductions-command-home-"));
    expect(command.status).toBe(4);
  });

  it("a configuration with no scope certificate gives untrusted with reason no-trusted-certificates and the sentence naming create-cert and --cert", async () => {
    const file = copyGenuine("tiny-macho-arm64", dir);
    await A.signing.signFileMachO(file, "@ta");

    const configDir = tempDir("reproductions-nocert-");
    const scopes = { "@tc": { author: { name: "Nobody", email: "nobody@example.com", url: "" } } };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
    const empty = new Signing(configDir);
    expect(empty.hasCert("@tc")).toBe(false);

    const result = await empty.verifyFile(file);
    expect(result.status).toBe("UNTRUSTED");
    expect(result.integrity.state).toBe("intact");
    expect(result.trust.reason).toBe("no-trusted-certificates");
    expect(result.trust.message).toBe("no trusted certificates are available; create one with 'the-seed signing create-cert' or name one with --cert <file>");
    expect(result.reason).toBe(result.trust.message);
  });

  it("a file signed in B and then changed, verified in A, is invalid with the signer still shown", async () => {
    const bFingerprint = expectPresent(B.signing.getCertInfo("@tb"), "B").fingerprint;

    const mac = copyGenuine("tiny-macho-arm64", dir);
    await B.signing.signFileMachO(mac, "@tb");
    invertByteAt(mac, 0x16ea);
    const macResult = await A.signing.verifyFile(mac);
    expect(macResult.status).toBe("INVALID");
    expect(macResult.trust.state).toBe("untrusted");
    expect(expectPresent(macResult.signer, "signer").fingerprint).toBe(bFingerprint);

    const detached = path.join(dir, "data.bin");
    fs.writeFileSync(detached, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    await B.signing.signFile(detached, { scope: "@tb" });
    invertByteAt(detached, 3);
    const detachedResult = await A.signing.verifyFile(detached);
    expect(detachedResult.status).toBe("INVALID");
    expect(expectPresent(detachedResult.signer, "signer").fingerprint).toBe(bFingerprint);
  });
});
