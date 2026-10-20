import fs from "fs";
import os from "os";
import path from "path";
import Signing from "../src/Signing";
import { expectPresent } from "./helpers/Assert";
import { fileDigest, nativeComponentPath, withoutNativeComponent } from "./helpers/NativeAbsent";

// Directory verification against the manifest. One configuration (scope @ta) signs and verifies
// everything here; every directory is created under os.tmpdir() and removed afterwards.
//
// Details these tests fix:
//   - a result's relativePath is the entry's path as written in the manifest
//   - `links[].target` is the link's target as a path relative to the directory, with "/" separators
//     (for a link made with a relative target in the same directory, just that name)
//   - an unlisted link has kind "link"; a regular unlisted file has kind "file"
//   - the reason of an unlisted text file in a manifest that records no skipped list contains
//     "sign the directory again", and the result's warnings contain
//     "this manifest does not record files that were not signed; sign the directory again to record them"
//   - the version 1 notice is a warning containing "earlier format"
//   - a recorded skipped file that no longer exists is a warning naming the file, with present false
//   - a missing listed file has status NOT_FOUND, is counted in counts.missing, and the directory
//     is then neither VALID nor UNTRUSTED

const created: string[] = [];
let savedHome: string | undefined;
let signing: Signing;
let configDirectory: string;

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Deterministic binary content: a leading NUL byte makes directory signing treat the file as binary. */
function binary(seed: number, length = 64): Buffer {
  return Buffer.from([0, ...Array.from({ length: length - 1 }, (_, index) => (index * seed + 3) & 0xff)]);
}

interface ManifestEntry {
  path: string;
  signatureFile: string | null;
  algorithm: string;
  signature: string;
  signatureType?: string;
}
interface Manifest {
  version: number;
  signedAt: string;
  certificate?: string;
  certificateFingerprint: string;
  files: ManifestEntry[];
  skipped?: string[];
}

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, ".signatures.json"), "utf-8"));
}

function writeManifest(dir: string, manifest: Manifest): void {
  fs.writeFileSync(path.join(dir, ".signatures.json"), JSON.stringify(manifest, null, 2));
}

/** Calls through to the real functions and records every path they are given, so a test can show a path was never opened. */
function spyOnOpens(): { touched: string[]; restore: () => void } {
  const touched: string[] = [];
  const spies = (["openSync", "readFileSync", "createReadStream"] as const).map((name) => {
    const original = (fs as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
    return jest.spyOn(fs as never, name as never).mockImplementation(((...args: unknown[]) => {
      const target = args[0];
      if (typeof target === "string" || Buffer.isBuffer(target)) {
        touched.push(path.resolve(target.toString()));
      }
      return original.apply(fs, args);
    }) as never);
  });
  return {
    touched,
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

beforeAll(async () => {
  savedHome = process.env.HOME;
  process.env.HOME = tempDir("directory-home-");
  const configDir = tempDir("directory-config-");
  configDirectory = configDir;
  const scopes = { "@ta": { author: { name: "Signer A", email: "signer@example.com", url: "" } } };
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: path.join(configDir, "prefix"), scopes }, null, 2));
  signing = new Signing(configDir);
  await signing.createCert({ validityDays: 365, scope: "@ta" });
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

describe("verifyDirectory", () => {
  let root: string;
  let dir: string;

  beforeEach(() => {
    root = tempDir("directory-case-");
    dir = path.join(root, "tree");
    fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(dir, "a.bin"), binary(7));
    fs.writeFileSync(path.join(dir, "lib", "b.bin"), binary(11, 80));
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), path.join(dir, "tiny.exe"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("an unchanged directory signed in A and verified in A is valid, with the manifest trusted by @ta", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    const result = await signing.verifyDirectory(dir);

    expect(result.status).toBe("VALID");
    expect(result.directory).toBe(path.resolve(dir));
    expect(result.manifest).toMatchObject({ version: 2, earlierFormat: false, fingerprintConsistent: true });
    expect(result.manifest.trust.state).toBe("trusted");
    expect(result.manifest.trust.anchor).toMatchObject({ source: "scope", scope: "@ta" });
    expect(result.manifest.certificate.fingerprint).toBe(expectPresent(signing.getCertInfo("@ta"), "certificate").fingerprint);
    expect(result.counts).toEqual({ valid: 3, untrusted: 0, invalid: 0, notFullySigned: 0, notChecked: 0, missing: 0, unlisted: 0, skipped: 0 });
    expect(result.results.map((entry) => entry.relativePath).sort()).toEqual(["a.bin", "lib/b.bin", "tiny.exe"]);
    for (const entry of result.results) {
      expect(entry.status).toBe("VALID");
      expect(entry.signerMatchesManifest).toBe(true);
      expect(entry.recordedValueMatches).toBe(true);
    }
    expect(result.unlisted).toEqual([]);
    expect(result.links).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notChecked).toEqual(expect.arrayContaining(["certificate chains", "revocation"]));
  });

  it("verifies a version 1 manifest with its entries checked as detached, the earlier-format warning, and unlisted files reported", async () => {
    // A version 1 manifest has no signatureType, no skipped list, and detached entries only
    fs.rmSync(path.join(dir, "tiny.exe"));
    const entries: ManifestEntry[] = [];
    for (const name of ["a.bin", "lib/b.bin"]) {
      const result = await signing.signFile(path.join(dir, name), { scope: "@ta", detached: true });
      const sig = JSON.parse(fs.readFileSync(expectPresent(result.signaturePath, "signaturePath"), "utf-8"));
      entries.push({ path: name, signatureFile: name + ".sig", algorithm: "SHA256", signature: sig.signature });
    }
    const certificate = fs.readFileSync(expectPresent(signing.getCertInfo("@ta"), "cert").certPath, "utf-8");
    writeManifest(dir, {
      version: 1,
      signedAt: new Date().toISOString(),
      certificate,
      certificateFingerprint: expectPresent(signing.getCertInfo("@ta"), "cert").fingerprint,
      files: entries,
    });
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");

    const result = await signing.verifyDirectory(dir);
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.earlierFormat).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("earlier format"))).toBe(true);
    expect(result.results.map((entry) => [entry.relativePath, entry.status, entry.form])).toEqual([
      ["a.bin", "VALID", "detached"],
      ["lib/b.bin", "VALID", "detached"],
    ]);
    expect(result.unlisted.map((entry) => entry.relativePath)).toEqual(["notes.txt"]);
    expect(result.status).toBe("INVALID");
  });

  it("records the text files it skipped, and reports each as present, not signed", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await signing.signDirectory(dir, { scope: "@ta" });

    expect(readManifest(dir).skipped).toEqual(["notes.txt"]);

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("VALID");
    expect(result.skipped).toEqual([{ relativePath: "notes.txt", present: true }]);
    expect(result.counts.skipped).toBe(1);
    expect(result.counts.unlisted).toBe(0);
    expect(result.unlisted).toEqual([]);
    expect(result.results.map((entry) => entry.relativePath)).not.toContain("notes.txt");
  });

  it("reports a text file as unlisted, with the re-sign hint, when a version 2 manifest has no skipped list", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await signing.signDirectory(dir, { scope: "@ta" });
    const manifest = readManifest(dir);
    delete manifest.skipped;
    writeManifest(dir, manifest);

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("INVALID");
    expect(result.unlisted).toHaveLength(1);
    expect(result.unlisted[0]).toMatchObject({ relativePath: "notes.txt", kind: "file" });
    expect(result.unlisted[0].reason).toContain("sign the directory again");
    expect(result.warnings).toContain("this manifest does not record files that were not signed; sign the directory again to record them");
    expect(result.skipped).toEqual([]);
  });

  it("lists a link inside the directory to a listed file under links, not as unlisted", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.symlinkSync("a.bin", path.join(dir, "a.link"));
    fs.symlinkSync("a.bin.sig", path.join(dir, "a.sig.link"));

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("VALID");
    expect(result.unlisted).toEqual([]);
    expect(result.counts.unlisted).toBe(0);
    expect(result.links.map((link) => [link.relativePath, link.target]).sort()).toEqual([
      ["a.link", "a.bin"],
      ["a.sig.link", "a.bin.sig"],
    ]);
  });

  it("reports a link to a file outside the directory as unlisted and does not follow it", async () => {
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, binary(13));
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.symlinkSync(outside, path.join(dir, "ext-link"));

    const spy = spyOnOpens();
    let result: Awaited<ReturnType<Signing["verifyDirectory"]>>;
    try {
      result = await signing.verifyDirectory(dir);
    } finally {
      spy.restore();
    }
    expect(spy.touched.filter((target) => target === outside || target === fs.realpathSync(outside))).toEqual([]);
    expect(result.status).toBe("INVALID");
    expect(result.unlisted).toHaveLength(1);
    expect(result.unlisted[0]).toMatchObject({ relativePath: "ext-link", kind: "link" });
    expect(result.unlisted[0].reason).toContain("not checked (link or special file)");
    expect(result.links).toEqual([]);
  });

  it("reports a dangling link as unlisted", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.symlinkSync("does-not-exist", path.join(dir, "dangling"));

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("INVALID");
    expect(result.unlisted.map((entry) => [entry.relativePath, entry.kind])).toEqual([["dangling", "link"]]);
  });

  it("fails an embedded entry whose recorded value is edited: the file differs from the fingerprint recorded in the manifest", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    const manifest = readManifest(dir);
    const entry = expectPresent(
      manifest.files.find((candidate) => candidate.path === "tiny.exe"),
      "tiny.exe entry"
    );
    expect(entry.signatureType).toBe("embedded");
    entry.signature = Buffer.alloc(32, 1).toString("base64");
    writeManifest(dir, manifest);

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("INVALID");
    const checked = expectPresent(
      result.results.find((candidate) => candidate.relativePath === "tiny.exe"),
      "tiny.exe result"
    );
    expect(checked.status).toBe("INVALID");
    expect(checked.recordedValueMatches).toBe(false);
    expect(checked.reason).toContain("the file differs from the fingerprint recorded in the manifest");
    // the embedded signature itself is still intact and by the manifest's signer
    expect(checked.integrity.state).toBe("intact");
    expect(checked.signerMatchesManifest).toBe(true);
  });

  it("fails a detached entry whose .sig is replaced by a new signature of the same content: the detached signature differs from the one recorded in the manifest", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    const before = fs.readFileSync(path.join(dir, "a.bin.sig"), "utf-8");
    await signing.signFile(path.join(dir, "a.bin"), { scope: "@ta", detached: true });
    // ECDSA signatures differ every time they are made
    expect(fs.readFileSync(path.join(dir, "a.bin.sig"), "utf-8")).not.toBe(before);

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("INVALID");
    const checked = expectPresent(
      result.results.find((candidate) => candidate.relativePath === "a.bin"),
      "a.bin result"
    );
    expect(checked.status).toBe("INVALID");
    expect(checked.recordedValueMatches).toBe(false);
    expect(checked.reason).toContain("the detached signature differs from the one recorded in the manifest");
    expect(checked.integrity.state).toBe("intact");
    expect(checked.signerMatchesManifest).toBe(true);
  });

  it("reports a missing listed file as missing and counts it", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.rmSync(path.join(dir, "lib", "b.bin"));

    const result = await signing.verifyDirectory(dir);
    const missing = expectPresent(
      result.results.find((candidate) => candidate.relativePath === "lib/b.bin"),
      "lib/b.bin result"
    );
    expect(missing.status).toBe("NOT_FOUND");
    expect(result.counts.missing).toBe(1);
    expect(result.counts.valid).toBe(2);
    expect(result.status).not.toBe("VALID");
    expect(result.status).not.toBe("UNTRUSTED");
  });

  it("reports a listed file whose detached signature file is missing as missing, naming the signature file", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.rmSync(path.join(dir, "lib", "b.bin.sig"));

    const result = await signing.verifyDirectory(dir);
    const entry = expectPresent(
      result.results.find((candidate) => candidate.relativePath === "lib/b.bin"),
      "lib/b.bin result"
    );
    expect(entry.status).toBe("NOT_FOUND");
    expect(entry.reason).toContain("lib/b.bin.sig");
    expect(result.counts.missing).toBe(1);
    expect(result.counts.invalid).toBe(0);
    expect(result.status).toBe("NOT_FOUND");
  });

  it("reports an entry that is a directory as invalid instead of failing the whole check", async () => {
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.mkdirSync(path.join(dir, "folder"));
    const manifest = readManifest(dir);
    manifest.files.push({ path: "folder", signatureFile: null, algorithm: "SHA256", signature: "", signatureType: "embedded" });
    writeManifest(dir, manifest);

    const result = await signing.verifyDirectory(dir);
    const entry = expectPresent(
      result.results.find((candidate) => candidate.relativePath === "folder"),
      "folder result"
    );
    expect(entry.status).toBe("INVALID");
    expect(result.status).toBe("INVALID");
    expect(result.counts.valid).toBe(3);
  });

  describe("a malformed manifest", () => {
    const malformed = /^Manifest file \.signatures\.json is malformed: .+/;

    it("is refused when it has no certificate", async () => {
      await signing.signDirectory(dir, { scope: "@ta" });
      const manifest = readManifest(dir);
      delete manifest.certificate;
      writeManifest(dir, manifest);
      await expect(signing.verifyDirectory(dir)).rejects.toThrow(malformed);
    });

    it("is refused when its certificate cannot be read", async () => {
      await signing.signDirectory(dir, { scope: "@ta" });
      const manifest = readManifest(dir);
      manifest.certificate = "-----BEGIN CERTIFICATE-----\nbm90IGEgY2VydGlmaWNhdGU=\n-----END CERTIFICATE-----\n";
      writeManifest(dir, manifest);
      await expect(signing.verifyDirectory(dir)).rejects.toThrow(malformed);
    });

    it("is refused when it is not JSON", async () => {
      fs.writeFileSync(path.join(dir, ".signatures.json"), "{ not json");
      await expect(signing.verifyDirectory(dir)).rejects.toThrow(malformed);
    });
  });

  it("warns, without failing, about a recorded skipped file that no longer exists", async () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    await signing.signDirectory(dir, { scope: "@ta" });
    fs.rmSync(path.join(dir, "notes.txt"));

    const result = await signing.verifyDirectory(dir);
    expect(result.status).toBe("VALID");
    expect(result.skipped).toEqual([{ relativePath: "notes.txt", present: false }]);
    expect(result.warnings.some((warning) => warning.includes("notes.txt"))).toBe(true);
    expect(result.unlisted).toEqual([]);
  });

  it("verifies a directory whose path has spaces and shell-special characters exactly", async () => {
    const odd = path.join(root, "my dir $(echo x) & 'q' ;`z`");
    fs.renameSync(dir, odd);
    await signing.signDirectory(odd, { scope: "@ta" });

    const result = await signing.verifyDirectory(odd);
    expect(result.status).toBe("VALID");
    expect(result.directory).toBe(path.resolve(odd));
    expect(result.counts.valid).toBe(3);
  });
});

describe("signDirectory without the native component", () => {
  type SigningModule = typeof import("../src/Signing");
  type ComponentModule = typeof import("../src/NativeComponent");

  let root: string;
  let dir: string;
  let withoutComponent: Signing;
  let component: ComponentModule;

  /** Every regular file under a directory with its digest, for asserting nothing changed. */
  function snapshot(directory: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          result[path.relative(directory, full)] = fileDigest(full);
        }
      }
    };
    walk(directory);
    return result;
  }

  beforeEach(() => {
    root = tempDir("directory-absent-");
    dir = path.join(root, "tree");
    fs.mkdirSync(dir);
    fs.copyFileSync("/bin/true", path.join(dir, "linux-program"));
    fs.writeFileSync(path.join(dir, "notes.txt"), "plain text\n");
    const loaded = withoutNativeComponent(() => ({
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- a fresh module registry is needed for each case
      Signing: (require("../src/Signing") as SigningModule).default,
      // eslint-disable-next-line @typescript-eslint/no-var-requires -- the same registry must supply the error class
      component: require("../src/NativeComponent") as ComponentModule,
    }));
    withoutComponent = new loaded.Signing(configDirectory);
    component = loaded.component;
  });

  afterEach(() => {
    jest.dontMock(nativeComponentPath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a directory holding a Windows program before any file is signed", async () => {
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), path.join(dir, "tiny.exe"));
    const before = snapshot(dir);

    let thrown: unknown;
    try {
      await withoutComponent.signDirectory(dir, { scope: "@ta" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(component.NativeComponentMissingError);
    expect((thrown as Error).message).toBe(component.nativeComponentMessage());
    expect(snapshot(dir)).toEqual(before);
    expect(fs.existsSync(path.join(dir, ".signatures.json"))).toBe(false);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".sig"))).toEqual([]);
  });

  it("signs a directory of text and Linux programs as it does with the component", async () => {
    const result = await withoutComponent.signDirectory(dir, { scope: "@ta" });

    expect(result.signed.map((entry) => path.basename(entry.filePath))).toEqual(["linux-program"]);
    expect(fs.existsSync(path.join(dir, "linux-program.sig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".signatures.json"))).toBe(true);
  });

  it("signs a directory holding a Windows program detached", async () => {
    fs.copyFileSync(path.join(__dirname, "fixtures", "binaries", "tiny.exe"), path.join(dir, "tiny.exe"));
    const exeBefore = fileDigest(path.join(dir, "tiny.exe"));

    const result = await withoutComponent.signDirectory(dir, { scope: "@ta", detached: true });

    expect(result.signed.map((entry) => entry.signatureType)).toEqual(expect.arrayContaining(["detached"]));
    expect(result.signed.every((entry) => entry.signatureType === "detached")).toBe(true);
    expect(fs.existsSync(path.join(dir, "tiny.exe.sig"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "linux-program.sig"))).toBe(true);
    expect(fileDigest(path.join(dir, "tiny.exe"))).toBe(exeBefore);
  });
});
