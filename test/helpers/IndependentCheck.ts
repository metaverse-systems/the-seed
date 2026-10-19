import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Checks of signed files by tools outside this package (osslsigncode and
 * openssl). Nothing here uses the signing code under test: every child process
 * gets an explicit environment and certificates for edge cases are written with
 * openssl.
 */

export function toolEnv(home: string): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LC_ALL: "C", TZ: "UTC" };
}

function run(command: string, args: string[], home: string): { status: number | null; output: string } {
  const result = spawnSync(command, args, { env: toolEnv(home), encoding: "utf8" });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  return { status: result.error ? null : result.status, output };
}

function available(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { env: toolEnv(os.tmpdir()), encoding: "utf8" });
  return !result.error && result.status === 0;
}

export function haveOsslsigncode(): boolean {
  return available("osslsigncode", ["--version"]);
}

export function haveOpenssl(): boolean {
  return available("openssl", ["version"]);
}

export interface OsslsigncodeResult {
  status: number | null;
  output: string;
  passed: boolean;
  digestsMatch: boolean;
  signatureCount: number;
}

function digestValue(lines: string[], label: string): string | null {
  for (const line of lines) {
    const at = line.indexOf(label);
    if (at >= 0) {
      const value = line.slice(at + label.length).replace(/^[\s:]+/, "").trim();
      return value.length > 0 ? value.toLowerCase() : null;
    }
  }
  return null;
}

export function osslsigncodeVerify(file: string, certPath: string, home: string): OsslsigncodeResult {
  const { status, output } = run("osslsigncode", ["verify", "-CAfile", certPath, "-in", file], home);
  const lines = output.split(/\r?\n/).map((line) => line.trim());
  const current = digestValue(lines, "Current message digest");
  const calculated = digestValue(lines, "Calculated message digest");
  const digestsMatch = current !== null && calculated !== null && current === calculated;
  const signatureCount = lines.filter((line) => line.startsWith("Signature Index:")).length;
  const isProgram = current !== null;
  const passed =
    status === 0 &&
    lines.includes("Signature verification: ok") &&
    lines.includes("Succeeded") &&
    !lines.includes("Failed") &&
    !lines.some((line) => line.toLowerCase().includes("asn1")) &&
    (!isProgram || digestsMatch);
  return { status, output, passed, digestsMatch, signatureCount };
}

export interface OpensslResult {
  status: number | null;
  output: string;
  passed: boolean;
}

export function opensslVerifyDetached(cms: Buffer, content: Buffer, certPath: string, home: string): OpensslResult {
  fs.mkdirSync(home, { recursive: true });
  const cmsPath = path.join(home, "container.der");
  const contentPath = path.join(home, "content.bin");
  fs.writeFileSync(cmsPath, cms);
  fs.writeFileSync(contentPath, content);
  const { status, output } = run(
    "openssl",
    ["cms", "-verify", "-inform", "DER", "-binary", "-in", cmsPath, "-content", contentPath, "-CAfile", certPath, "-purpose", "any", "-out", "/dev/null"],
    home,
  );
  return { status, output, passed: status === 0 && output.includes("Verification successful") };
}

function mustRun(command: string, args: string[], home: string): void {
  const { status, output } = run(command, args, home);
  if (status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed (${status}): ${output}`);
  }
}

export interface EdgeCaseOptions {
  serialHex: string;
  longNames?: boolean;
}

export function edgeCaseScope(home: string, options: EdgeCaseOptions): { keyPath: string; certPath: string } {
  fs.mkdirSync(home, { recursive: true });
  const keyPath = path.join(home, "edge-key.pem");
  const certPath = path.join(home, "edge-cert.pem");
  const subject = options.longNames
    ? "/CN=edge" + Array.from({ length: 6 }, (_, i) => `/OU=${String(i).repeat(60)}`).join("")
    : "/CN=edge";
  mustRun("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath], home);
  mustRun(
    "openssl",
    ["req", "-x509", "-new", "-key", keyPath, "-subj", subject, "-set_serial", "0x" + options.serialHex, "-days", "36500", "-sha256", "-out", certPath],
    home,
  );
  return { keyPath, certPath };
}

export type ReplacementKey = "rsa2048" | "p384" | "ed25519" | "p256-other";

export function replaceScopeKey(configDir: string, scope: string, kind: ReplacementKey): void {
  const keyPath = path.join(configDir, "signing", scope, "key.pem");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "replace-key-"));
  try {
    const commands: Record<ReplacementKey, string[]> = {
      rsa2048: ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", keyPath],
      p384: ["ecparam", "-name", "secp384r1", "-genkey", "-noout", "-out", keyPath],
      ed25519: ["genpkey", "-algorithm", "ED25519", "-out", keyPath],
      "p256-other": ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath],
    };
    mustRun("openssl", commands[kind], home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
