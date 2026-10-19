import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { expectPresent } from "./helpers/Assert";
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
