import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import * as x509 from "@peculiar/x509";
import Signing from "../src/Signing";
import { certificateFingerprint, EARLIER_FORM_NOTICE_MAC, EARLIER_FORM_NOTICE_WINDOWS, evaluateTrust, exitStatusOf, NOT_CHECKED_ALWAYS, outcomeOf, readCertificates, worst } from "../src/Trust";
import type { IntegrityResult, TrustAnchor, TrustedCertificates, TrustResult } from "../src/types";
import { optionalExternalCheck } from "./helpers/ExternalTools";
import { resignHint } from "../src/cli/Hints";

// Status strings of the verification result. The functions under test take the status type, which
// gains its new members in a later step, so the values are typed through the functions themselves.
type Status = Parameters<typeof exitStatusOf>[0];
const ORDER = ["VALID", "UNTRUSTED", "NOT_FOUND", "NOT_CHECKED", "NOT_FULLY_SIGNED", "INVALID"] as unknown as Status[];

const created: string[] = [];
let savedHome: string | undefined;

beforeAll(() => {
  // Nothing here reads the real home; the Signing objects below get explicit configuration directories
  savedHome = process.env.HOME;
  process.env.HOME = tempDir("trust-home-");
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

afterEach(() => {
  jest.restoreAllMocks();
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Writes config.json naming the scopes in the given order. */
function writeConfig(configDir: string, scopes: string[]): void {
  const table: Record<string, unknown> = {};
  for (const scope of scopes) {
    table[scope] = { author: { name: "Test " + scope, email: "t@example.com", url: "" } };
  }
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ prefix: "/tmp/seed-test-prefix", scopes: table }, null, 2));
}

/** A configuration directory naming `scopes`, with a created certificate for each of `withCert`. */
async function setup(scopes: string[], withCert: string[]): Promise<{ signing: Signing; configDir: string; fingerprints: Record<string, string> }> {
  const configDir = tempDir("trust-config-");
  writeConfig(configDir, scopes);
  const signing = new Signing(configDir);
  const fingerprints: Record<string, string> = {};
  for (const scope of withCert) {
    fingerprints[scope] = (await signing.createCert({ validityDays: 365, scope })).fingerprint;
  }
  return { signing, configDir, fingerprints };
}

function derOf(signing: Signing, scope: string): Buffer {
  return Buffer.from(new crypto.X509Certificate(fs.readFileSync(signing.scopeCertPath(scope), "utf-8")).raw);
}

function pemOf(der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) as string[];
  return "-----BEGIN CERTIFICATE-----\n" + lines.join("\n") + "\n-----END CERTIFICATE-----\n";
}

function sha256Hex(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

const canChmod = (): boolean => process.getuid?.() !== 0;

// ── certificateFingerprint ───────────────────────────────────

describe("certificateFingerprint", () => {
  it("gives SHA256:<lowercase hex> of the DER, equal to Node's own SHA-256 of the same certificate", async () => {
    const { signing } = await setup(["@a"], ["@a"]);
    const der = derOf(signing, "@a");
    const fingerprint = certificateFingerprint(der);
    expect(fingerprint).toMatch(/^SHA256:[0-9a-f]{64}$/);
    expect(fingerprint).toBe("SHA256:" + sha256Hex(der));
    const node = new crypto.X509Certificate(der);
    expect(fingerprint).toBe("SHA256:" + node.fingerprint256.replace(/:/g, "").toLowerCase());
  });

  it("is the fingerprint the tool already prints for a created certificate", async () => {
    const { signing, fingerprints } = await setup(["@a"], ["@a"]);
    expect(certificateFingerprint(derOf(signing, "@a"))).toBe(fingerprints["@a"]);
  });
});

// ── readCertificates ─────────────────────────────────────────

describe("readCertificates", () => {
  let dir: string;
  let derA: Buffer;
  let derB: Buffer;

  beforeAll(async () => {
    const { signing } = await setup(["@a", "@b"], ["@a", "@b"]);
    derA = derOf(signing, "@a");
    derB = derOf(signing, "@b");
  });

  beforeEach(() => {
    dir = tempDir("trust-read-");
  });

  it("reads every CERTIFICATE block of a PEM file, in file order", () => {
    const file = path.join(dir, "two.pem");
    fs.writeFileSync(file, "# a comment line before the blocks\n" + pemOf(derA) + "\n" + pemOf(derB));
    const certificates = readCertificates(file);
    expect(certificates).toHaveLength(2);
    expect(certificates[0].equals(derA)).toBe(true);
    expect(certificates[1].equals(derB)).toBe(true);
  });

  it("reads a DER file as one certificate", () => {
    const file = path.join(dir, "one.der");
    fs.writeFileSync(file, derA);
    const certificates = readCertificates(file);
    expect(certificates).toHaveLength(1);
    expect(certificates[0].equals(derA)).toBe(true);
  });

  it("throws naming the path for a missing file", () => {
    const file = path.join(dir, "missing.pem");
    expect(() => readCertificates(file)).toThrow(file);
  });

  it("throws naming the path for an unreadable file", () => {
    if (!optionalExternalCheck("trust-unreadable-file", canChmod(), "running as root, which can read any file")) {
      return;
    }
    const file = path.join(dir, "locked.pem");
    fs.writeFileSync(file, pemOf(derA));
    fs.chmodSync(file, 0o000);
    expect(() => readCertificates(file)).toThrow(file);
  });

  it("throws naming the path for a text file that holds no certificate", () => {
    const file = path.join(dir, "notes.txt");
    fs.writeFileSync(file, "this is not a certificate\n");
    expect(() => readCertificates(file)).toThrow(file);
  });
});

// ── evaluateTrust ────────────────────────────────────────────

describe("evaluateTrust", () => {
  let derA: Buffer;
  let derB: Buffer;
  let derC: Buffer;
  let anchorA: TrustAnchor;
  let anchorB: TrustAnchor;

  beforeAll(async () => {
    const { signing } = await setup(["@a", "@b", "@c"], ["@a", "@b", "@c"]);
    derA = derOf(signing, "@a");
    derB = derOf(signing, "@b");
    derC = derOf(signing, "@c");
    anchorA = { source: "scope", scope: "@a", fingerprint: certificateFingerprint(derA), certPath: signing.scopeCertPath("@a") };
    anchorB = { source: "supplied", path: "/somewhere/b.pem", fingerprint: certificateFingerprint(derB) };
  });

  function set(anchors: TrustAnchor[]): TrustedCertificates {
    return { source: "scopes", anchors, warnings: [] };
  }

  it("trusts a signer whose fingerprint equals a scope anchor, reporting that anchor", () => {
    const result = evaluateTrust(derA, set([anchorB, anchorA]));
    expect(result.state).toBe("trusted");
    expect(result.anchor).toEqual(anchorA);
    expect(result.reason).toBeUndefined();
  });

  it("trusts a signer whose fingerprint equals a supplied anchor, reporting that anchor", () => {
    const result = evaluateTrust(derB, set([anchorA, anchorB]));
    expect(result.state).toBe("trusted");
    expect(result.anchor).toEqual(anchorB);
  });

  it("reports the first matching anchor when two anchors carry the same fingerprint", () => {
    const twin: TrustAnchor = { source: "supplied", path: "/twin/a.pem", fingerprint: anchorA.fingerprint };
    expect(evaluateTrust(derA, set([twin, anchorA])).anchor).toEqual(twin);
    expect(evaluateTrust(derA, set([anchorA, twin])).anchor).toEqual(anchorA);
  });

  it("does not trust a signer that is not an anchor: unknown-signer, with the sentence the command prints", () => {
    const result = evaluateTrust(derC, set([anchorA, anchorB]));
    expect(result.state).toBe("untrusted");
    expect(result.reason).toBe("unknown-signer");
    expect(result.anchor).toBeUndefined();
    expect(result.message).toBe("signer certificate is not one of the trusted certificates");
  });

  it("does not trust a file with no signer certificate: no-signer", () => {
    const result = evaluateTrust(null, set([anchorA]));
    expect(result.state).toBe("untrusted");
    expect(result.reason).toBe("no-signer");
    // The wording of this sentence is the implementer's; it must say something
    expect(typeof result.message).toBe("string");
    expect((result.message as string).length).toBeGreaterThan(0);
  });

  it("does not trust anything when there are no anchors: no-trusted-certificates, with the guidance sentence", () => {
    const result = evaluateTrust(derA, set([]));
    expect(result.state).toBe("untrusted");
    expect(result.reason).toBe("no-trusted-certificates");
    expect(result.message).toContain("no trusted certificates are available");
    expect(result.message).toContain("\"the-seed signing create-cert\"");
    expect(result.message).not.toContain("'the-seed");
    expect(result.message).toContain("--cert <file>");
  });

  it.each([
    ["Windows", EARLIER_FORM_NOTICE_WINDOWS],
    ["Mac", EARLIER_FORM_NOTICE_MAC],
  ])("the earlier-form notice for %s quotes the command that signs the file again", (_name, notice) => {
    const command = /"the-seed [^"]+"/.exec(resignHint()) as RegExpExecArray;
    expect(command[0]).toBe("\"the-seed signing sign <path>\"");
    expect(notice).toContain(`sign the file again with ${command[0]}`);
    expect(notice).not.toContain("'the-seed");
  });
});

// ── outcomeOf, worst, exitStatusOf, NOT_CHECKED_ALWAYS ───────

describe("outcomeOf", () => {
  const intact: IntegrityResult = { state: "intact", checked: ["signature"] };
  const invalid: IntegrityResult = { state: "invalid", reason: "page 1 does not match", checked: [] };
  const unsignedOnly: IntegrityResult = { state: "invalid", reason: "slice x86_64 is not signed", checked: [], unsignedOnly: ["x86_64"] };
  const notChecked: IntegrityResult = { state: "not-checked", reason: "unsupported algorithm", checked: [] };
  const none: IntegrityResult = { state: "none", checked: [] };

  const trusted: TrustResult = { state: "trusted", anchor: { source: "scope", scope: "@a", fingerprint: "SHA256:aa", certPath: "/c/cert.pem" } };
  const untrusted: TrustResult = { state: "untrusted", reason: "unknown-signer", message: "signer certificate is not one of the trusted certificates" };
  const notApplicable: TrustResult = { state: "not-applicable" };

  it("none with trust not applicable is NOT_FOUND", () => {
    expect(outcomeOf(none, notApplicable)).toBe("NOT_FOUND");
  });

  it("not-checked with trust not applicable is NOT_CHECKED", () => {
    expect(outcomeOf(notChecked, notApplicable)).toBe("NOT_CHECKED");
  });

  it("invalid with only unsigned slices is NOT_FULLY_SIGNED whatever the trust", () => {
    for (const trust of [trusted, untrusted, notApplicable]) {
      expect(outcomeOf(unsignedOnly, trust)).toBe("NOT_FULLY_SIGNED");
    }
  });

  it("invalid is INVALID whatever the trust, so an untrusted and modified file is INVALID", () => {
    for (const trust of [trusted, untrusted, notApplicable]) {
      expect(outcomeOf(invalid, trust)).toBe("INVALID");
    }
  });

  it("intact and trusted is VALID", () => {
    expect(outcomeOf(intact, trusted)).toBe("VALID");
  });

  it("intact and untrusted is UNTRUSTED", () => {
    expect(outcomeOf(intact, untrusted)).toBe("UNTRUSTED");
  });
});

describe("worst", () => {
  it("follows VALID < UNTRUSTED < NOT_FOUND < NOT_CHECKED < NOT_FULLY_SIGNED < INVALID for every pair", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        expect(worst([ORDER[i], ORDER[j]])).toBe(ORDER[Math.max(i, j)]);
      }
    }
  });

  it("picks the worst of a longer list, wherever it is", () => {
    expect(worst([ORDER[0], ORDER[1], ORDER[0]])).toBe("UNTRUSTED");
    expect(worst([ORDER[5], ORDER[0], ORDER[3]])).toBe("INVALID");
    expect(worst([ORDER[3]])).toBe("NOT_CHECKED");
  });
});

describe("exitStatusOf", () => {
  it("gives 0 for VALID, 4 for UNTRUSTED and 1 for every other status", () => {
    expect(exitStatusOf("VALID" as Status)).toBe(0);
    expect(exitStatusOf("UNTRUSTED" as Status)).toBe(4);
    for (const status of ["INVALID", "NOT_FULLY_SIGNED", "NOT_CHECKED", "NOT_FOUND"]) {
      expect(exitStatusOf(status as Status)).toBe(1);
    }
  });
});

describe("NOT_CHECKED_ALWAYS", () => {
  it("lists the four things the tool never checks, in order", () => {
    expect([...NOT_CHECKED_ALWAYS]).toEqual(["certificate chains", "revocation", "signing time", "acceptance by the platform's own verifier"]);
  });
});

// ── Signing.loadTrust ────────────────────────────────────────

describe("Signing.loadTrust", () => {
  it("with no paths, makes one anchor for a configured scope that has a certificate, named by its scope", async () => {
    const { signing, fingerprints } = await setup(["@has", "@none"], ["@has"]);
    const trust = signing.loadTrust();
    expect(trust.source).toBe("scopes");
    expect(trust.warnings).toEqual([]);
    expect(trust.anchors).toEqual([{ source: "scope", scope: "@has", fingerprint: fingerprints["@has"], certPath: signing.scopeCertPath("@has") }]);
  });

  it("lists scope anchors in configuration order", async () => {
    const { signing, fingerprints } = await setup(["@b", "@a"], ["@a", "@b"]);
    const trust = signing.loadTrust();
    expect(trust.anchors.map((anchor) => (anchor.source === "scope" ? anchor.scope : "?"))).toEqual(["@b", "@a"]);
    expect(trust.anchors.map((anchor) => anchor.fingerprint)).toEqual([fingerprints["@b"], fingerprints["@a"]]);
  });

  it("warns, naming the scope, about a certificate file that cannot be read, and does not trust it", async () => {
    if (!optionalExternalCheck("trust-unreadable-scope-cert", canChmod(), "running as root, which can read any file")) {
      return;
    }
    const { signing, fingerprints } = await setup(["@good", "@locked"], ["@good", "@locked"]);
    fs.chmodSync(signing.scopeCertPath("@locked"), 0o000);
    const trust = signing.loadTrust();
    expect(trust.anchors.map((anchor) => anchor.fingerprint)).toEqual([fingerprints["@good"]]);
    expect(trust.warnings).toHaveLength(1);
    expect(trust.warnings[0]).toContain("@locked");
  });

  it("warns, naming the scope, about a certificate file that holds no certificate", async () => {
    const { signing } = await setup(["@junk"], ["@junk"]);
    fs.writeFileSync(signing.scopeCertPath("@junk"), "not a certificate\n");
    const trust = signing.loadTrust();
    expect(trust.anchors).toEqual([]);
    expect(trust.warnings).toHaveLength(1);
    expect(trust.warnings[0]).toContain("@junk");
  });

  it("does not trust the certificate of a scope that is no longer in config.json", async () => {
    const { signing, configDir, fingerprints } = await setup(["@kept", "@gone"], ["@kept", "@gone"]);
    writeConfig(configDir, ["@kept"]);
    expect(fs.existsSync(signing.scopeCertPath("@gone"))).toBe(true);
    const trust = signing.loadTrust();
    expect(trust.anchors.map((anchor) => anchor.fingerprint)).toEqual([fingerprints["@kept"]]);
    expect(trust.warnings).toEqual([]);
  });

  describe("with certificate files", () => {
    let signing: Signing;
    let derA: Buffer;
    let derB: Buffer;
    let dir: string;

    beforeAll(async () => {
      const setupResult = await setup(["@a", "@b"], ["@a", "@b"]);
      signing = setupResult.signing;
      derA = derOf(signing, "@a");
      derB = derOf(signing, "@b");
    });

    beforeEach(() => {
      dir = tempDir("trust-load-");
    });

    it("makes one supplied anchor per certificate of a PEM file, in file order, and trusts only those", () => {
      const file = path.join(dir, "two.pem");
      fs.writeFileSync(file, pemOf(derB) + pemOf(derA));
      const trust = signing.loadTrust([file]);
      expect(trust.source).toBe("supplied");
      expect(trust.warnings).toEqual([]);
      expect(trust.anchors).toEqual([
        { source: "supplied", path: file, fingerprint: certificateFingerprint(derB) },
        { source: "supplied", path: file, fingerprint: certificateFingerprint(derA) },
      ]);
    });

    it("keeps the order of the paths given, across files", () => {
      const first = path.join(dir, "first.pem");
      const second = path.join(dir, "second.pem");
      fs.writeFileSync(first, pemOf(derB));
      fs.writeFileSync(second, pemOf(derA));
      const trust = signing.loadTrust([first, second]);
      expect(trust.anchors.map((anchor) => (anchor.source === "supplied" ? anchor.path : "?"))).toEqual([first, second]);
      expect(trust.anchors.map((anchor) => anchor.fingerprint)).toEqual([certificateFingerprint(derB), certificateFingerprint(derA)]);
    });

    it("reads a DER file", () => {
      const file = path.join(dir, "b.der");
      fs.writeFileSync(file, derB);
      const trust = signing.loadTrust([file]);
      expect(trust.anchors).toEqual([{ source: "supplied", path: file, fingerprint: certificateFingerprint(derB) }]);
    });

    it("reports a supplied certificate that is also a scope certificate as supplied, and drops the scope anchors", () => {
      const file = path.join(dir, "a.pem");
      fs.writeFileSync(file, pemOf(derA));
      const trust = signing.loadTrust([file]);
      expect(trust.anchors).toHaveLength(1);
      expect(trust.anchors[0].source).toBe("supplied");
    });

    it("throws 'Trusted certificate file <path> does not exist' for a missing path", () => {
      const file = path.join(dir, "missing.pem");
      expect(() => signing.loadTrust([file])).toThrow("Trusted certificate file " + file + " does not exist");
    });

    it("throws 'Trusted certificate file <path> cannot be read: <detail>' for an unreadable path", () => {
      if (!optionalExternalCheck("trust-unreadable-supplied", canChmod(), "running as root, which can read any file")) {
        return;
      }
      const file = path.join(dir, "locked.pem");
      fs.writeFileSync(file, pemOf(derA));
      fs.chmodSync(file, 0o000);
      let message = "";
      try {
        signing.loadTrust([file]);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message.startsWith("Trusted certificate file " + file + " cannot be read: ")).toBe(true);
      expect(message.length).toBeGreaterThan(("Trusted certificate file " + file + " cannot be read: ").length);
    });

    it("throws 'Trusted certificate file <path> holds no certificate' for a text file", () => {
      const file = path.join(dir, "notes.txt");
      fs.writeFileSync(file, "just words\n");
      expect(() => signing.loadTrust([file])).toThrow("Trusted certificate file " + file + " holds no certificate");
    });

    it("throws for the first bad path before reading anything else", () => {
      const good = path.join(dir, "good.pem");
      const bad = path.join(dir, "bad.pem");
      fs.writeFileSync(good, pemOf(derA));
      expect(() => signing.loadTrust([good, bad])).toThrow(bad);
    });

    it("opens no private key file, by default or with paths", () => {
      const file = path.join(dir, "a.pem");
      fs.writeFileSync(file, pemOf(derA));
      const touched: string[] = [];
      const readFileSync = fs.readFileSync;
      const openSync = fs.openSync;
      jest.spyOn(fs, "readFileSync").mockImplementation(((target: unknown, ...rest: unknown[]) => {
        touched.push(String(target));
        return (readFileSync as (...args: unknown[]) => unknown)(target, ...rest);
      }) as typeof fs.readFileSync);
      jest.spyOn(fs, "openSync").mockImplementation(((target: unknown, ...rest: unknown[]) => {
        touched.push(String(target));
        return (openSync as (...args: unknown[]) => unknown)(target, ...rest);
      }) as typeof fs.openSync);
      signing.loadTrust();
      signing.loadTrust([file]);
      expect(touched.length).toBeGreaterThan(0);
      expect(touched.filter((name) => name.endsWith("key.pem"))).toEqual([]);
    });
  });
});

// ── Signer certificate details ───────────────────────────────

describe("signer certificate details (_buildSignerInfo)", () => {
  async function selfSigned(
    keyAlgorithm: crypto.webcrypto.EcKeyGenParams | crypto.webcrypto.RsaHashedKeyGenParams,
    signingAlgorithm: crypto.webcrypto.Algorithm | crypto.webcrypto.RsaHashedImportParams | crypto.webcrypto.EcdsaParams,
    notBefore: Date,
    notAfter: Date
  ): Promise<crypto.X509Certificate> {
    const webcrypto = crypto.webcrypto as unknown as crypto.webcrypto.Crypto;
    x509.cryptoProvider.set(webcrypto);
    const keys = (await webcrypto.subtle.generateKey(keyAlgorithm, true, ["sign", "verify"])) as crypto.webcrypto.CryptoKeyPair;
    const certificate = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=details",
      notBefore,
      notAfter,
      signingAlgorithm,
      keys,
    });
    return new crypto.X509Certificate(certificate.toString("pem"));
  }

  const DAY = 24 * 60 * 60 * 1000;
  const p256 = { name: "ECDSA", namedCurve: "P-256" } as crypto.webcrypto.EcKeyGenParams;

  it("names the key of a created certificate and reports it as valid now", async () => {
    const { signing } = await setup(["@a"], ["@a"]);
    const info = signing._buildSignerInfo(new crypto.X509Certificate(fs.readFileSync(signing.scopeCertPath("@a"), "utf-8")));
    expect(info.keyType).toBe("ECDSA P-256");
    expect(info.isExpired).toBe(false);
    expect(info.isNotYetValid).toBe(false);
  });

  it("names an ECDSA P-384 key", async () => {
    const { signing } = await setup([], []);
    const cert = await selfSigned({ name: "ECDSA", namedCurve: "P-384" } as crypto.webcrypto.EcKeyGenParams, { name: "ECDSA", hash: "SHA-384" } as crypto.webcrypto.EcdsaParams, new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    expect(signing._buildSignerInfo(cert).keyType).toBe("ECDSA P-384");
  });

  it("names an RSA key with its size", async () => {
    const { signing } = await setup([], []);
    const rsa = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as crypto.webcrypto.RsaHashedKeyGenParams;
    const cert = await selfSigned(rsa, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as crypto.webcrypto.RsaHashedImportParams, new Date(Date.now() - DAY), new Date(Date.now() + DAY));
    expect(signing._buildSignerInfo(cert).keyType).toBe("RSA 2048");
  });

  it("marks a certificate whose validity ended a day ago as expired and not 'not yet valid'", async () => {
    const { signing } = await setup([], []);
    const cert = await selfSigned(p256, { name: "ECDSA", hash: "SHA-256" } as crypto.webcrypto.EcdsaParams, new Date(Date.now() - 30 * DAY), new Date(Date.now() - DAY));
    const info = signing._buildSignerInfo(cert);
    expect(info.isExpired).toBe(true);
    expect(info.isNotYetValid).toBe(false);
    expect(info.notAfter.toISOString().slice(0, 10)).toBe(new Date(cert.validTo).toISOString().slice(0, 10));
  });

  it("marks a certificate that is not valid until tomorrow as not yet valid and not expired", async () => {
    const { signing } = await setup([], []);
    const cert = await selfSigned(p256, { name: "ECDSA", hash: "SHA-256" } as crypto.webcrypto.EcdsaParams, new Date(Date.now() + DAY), new Date(Date.now() + 30 * DAY));
    const info = signing._buildSignerInfo(cert);
    expect(info.isNotYetValid).toBe(true);
    expect(info.isExpired).toBe(false);
    expect(info.notBefore.toISOString().slice(0, 10)).toBe(new Date(cert.validFrom).toISOString().slice(0, 10));
  });
});

// ── Expiry warnings ──────────────────────────────────────────

describe("verify with a scope certificate outside its validity", () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Choice: the warnings are worded exactly as below, with the date in UTC.
  const expiredWarning = (date: string): string => `signer certificate expired on ${date}; the signing time is not established because timestamps are not checked`;
  const notYetWarning = (date: string): string => `signer certificate is not valid until ${date}`;

  /** A configuration whose scope certificate and key were written by hand with the given validity. */
  async function scopeWithValidity(scope: string, notBefore: Date, notAfter: Date): Promise<{ signing: Signing; certPath: string; certificate: crypto.X509Certificate }> {
    const configDir = tempDir("trust-expiry-");
    writeConfig(configDir, [scope]);
    const signing = new Signing(configDir);
    const webcrypto = crypto.webcrypto as unknown as crypto.webcrypto.Crypto;
    x509.cryptoProvider.set(webcrypto);
    const keys = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" } as crypto.webcrypto.EcKeyGenParams, true, ["sign", "verify"])) as crypto.webcrypto.CryptoKeyPair;
    const generated = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "0a",
      name: "CN=Validity Test, O=" + scope,
      notBefore,
      notAfter,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" } as crypto.webcrypto.EcdsaParams,
      keys,
    });
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
    fs.mkdirSync(path.dirname(signing.scopeCertPath(scope)), { recursive: true });
    fs.writeFileSync(signing.scopeCertPath(scope), generated.toString("pem"));
    fs.writeFileSync(signing.scopeKeyPath(scope), "-----BEGIN PRIVATE KEY-----\n" + (pkcs8.toString("base64").match(/.{1,64}/g) as string[]).join("\n") + "\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
    return { signing, certPath: signing.scopeCertPath(scope), certificate: new crypto.X509Certificate(generated.toString("pem")) };
  }

  function scratchFile(): string {
    const file = path.join(tempDir("trust-expiry-file-"), "data.bin");
    fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    return file;
  }

  const utcDate = (text: string): string => new Date(text).toISOString().slice(0, 10);

  it("an expired scope certificate gives VALID with the expiry warning naming the certificate's notAfter date in UTC", async () => {
    const { signing, certificate } = await scopeWithValidity("@old", new Date(Date.now() - 30 * DAY), new Date(Date.now() - DAY));
    const file = scratchFile();
    await signing.signFile(file, { scope: "@old", force: true });

    const result = await signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    expect(result.trust.state).toBe("trusted");
    expect(result.warnings).toContain(expiredWarning(utcDate(certificate.validTo)));
  });

  it("a scope certificate that is not valid until tomorrow gives VALID with the 'is not valid until' warning", async () => {
    const { signing, certificate } = await scopeWithValidity("@new", new Date(Date.now() + DAY), new Date(Date.now() + 30 * DAY));
    const file = scratchFile();
    await signing.signFile(file, { scope: "@new", force: true });

    const result = await signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    expect(result.warnings).toContain(notYetWarning(utcDate(certificate.validFrom)));
    expect(result.warnings.filter((warning) => warning.includes("expired on"))).toEqual([]);
  });

  it("a certificate inside its validity gives no expiry or validity warning", async () => {
    const { signing } = await setup(["@ok"], ["@ok"]);
    const file = scratchFile();
    await signing.signFile(file, { scope: "@ok" });

    const result = await signing.verifyFile(file);
    expect(result.status).toBe("VALID");
    expect(result.warnings.filter((warning) => /expired on|not valid until/.test(warning))).toEqual([]);
  });

  it("an expired certificate used as a supplied anchor still matches by fingerprint, with the same warning", async () => {
    const { signing, certPath, certificate } = await scopeWithValidity("@old", new Date(Date.now() - 30 * DAY), new Date(Date.now() - DAY));
    const file = scratchFile();
    await signing.signFile(file, { scope: "@old", force: true });

    // A configuration that does not know the scope, so only the supplied certificate can match
    const other = await setup(["@other"], ["@other"]);
    const trust = other.signing.loadTrust([certPath]);
    const result = await other.signing.verifyFile(file, { trust });
    expect(result.status).toBe("VALID");
    expect(result.trust.state).toBe("trusted");
    expect(result.trust.anchor).toMatchObject({ source: "supplied", fingerprint: certificateFingerprint(Buffer.from(certificate.raw)) });
    expect(result.warnings).toContain(expiredWarning(utcDate(certificate.validTo)));
  });
});
