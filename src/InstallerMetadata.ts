import { createHash } from "crypto";

/**
 * Raised when a value of the project cannot be carried into the installer: a character XML cannot hold,
 * a version that is not a valid installer version, or a product name that is not a usable folder name.
 */
export class InstallerMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallerMetadataError";
  }
}

/** A package version read as SemVer 2.0. */
export interface PackageVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
  build: string | null;
  raw: string;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Sanitize a filename for use in a WiX identifier: other characters become underscores, a leading digit gets an underscore. */
export function sanitizeId(name: string): string {
  let id = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(id)) {
    id = "_" + id;
  }
  return id;
}

function codePointLabel(unit: number): string {
  return "U+" + unit.toString(16).toUpperCase().padStart(4, "0");
}

/** The first character XML 1.0 cannot carry, as `U+XXXX`, or null. */
function firstUncarriable(value: string): string | null {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x08 || unit === 0x0B || unit === 0x0C || (unit >= 0x0E && unit <= 0x1F) || unit === 0xFFFE || unit === 0xFFFF) {
      return codePointLabel(unit);
    }
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xDC00 && next <= 0xDFFF) {
        index++;
        continue;
      }
      return codePointLabel(unit);
    }
    if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return codePointLabel(unit);
    }
  }
  return null;
}

/**
 * Escapes a value for use inside a double- or single-quoted XML attribute. Tabs and line breaks become
 * character references so a reader keeps them.
 * @throws InstallerMetadataError when the value holds a character XML 1.0 cannot carry.
 */
export function xmlAttribute(value: string): string {
  const bad = firstUncarriable(value);
  if (bad !== null) {
    throw new InstallerMetadataError("The value \"" + value + "\" contains " + bad + ", which cannot be written to the installer description.");
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}

/**
 * Reads a package version as SemVer 2.0.
 * @throws InstallerMetadataError when it is not a valid version.
 */
export function parsePackageVersion(raw: string): PackageVersion {
  const match = SEMVER.exec(raw);
  if (match === null) {
    throw new InstallerMetadataError(
      "The package version \"" + raw + "\" is not a valid version (MAJOR.MINOR.PATCH, optionally with -prerelease or +build)."
    );
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
    build: match[5] ?? null,
    raw,
  };
}

/**
 * The installer version of a package version: its three numbers. `note` says that a suffix was dropped, or is null.
 * @throws InstallerMetadataError when a number is above what an installer version holds (255, 255, 65535).
 */
export function installerVersion(v: PackageVersion): { version: string; note: string | null } {
  const limits: Array<[string, number, number]> = [["major", v.major, 255], ["minor", v.minor, 255], ["patch", v.patch, 65535]];
  for (const [part, value, limit] of limits) {
    if (value > limit) {
      throw new InstallerMetadataError(
        "The package version \"" + v.raw + "\" cannot be an installer version: the " + part + " number " + value + " is above " + limit + "."
      );
    }
  }
  const version = v.major + "." + v.minor + "." + v.patch;
  let note: string | null = null;
  if (v.prerelease !== null || v.build !== null) {
    const dropped = v.prerelease !== null && v.build !== null ? "prerelease and build" : v.prerelease !== null ? "prerelease" : "build";
    note = "Installer version " + version + " (from " + v.raw + "; installer versions hold three numbers, so the " + dropped + " suffix is dropped).";
  }
  return { version, note };
}

const RESERVED_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Checks that a product name can be a Windows folder name.
 * @throws InstallerMetadataError naming the first offending character, the trailing space or dot, or the reserved name.
 */
export function checkFolderName(name: string): void {
  for (const char of name) {
    const code = char.codePointAt(0)!;
    if ("<>:\"/\\|?*".includes(char)) {
      throw new InstallerMetadataError(
        "The product name \"" + name + "\" contains \"" + char + "\", which a Windows folder name cannot contain."
      );
    }
    if (code < 0x20) {
      throw new InstallerMetadataError(
        "The product name \"" + name + "\" contains " + codePointLabel(code) + ", which a Windows folder name cannot contain."
      );
    }
  }
  if (name.endsWith(" ") || name.endsWith(".")) {
    throw new InstallerMetadataError("The product name \"" + name + "\" ends with a space or a dot, which a Windows folder name cannot do.");
  }
  const stem = name.split(".")[0];
  if (RESERVED_NAMES.test(stem)) {
    throw new InstallerMetadataError("The product name \"" + name + "\" is a reserved Windows name and cannot be a folder name.");
  }
}

/**
 * A WiX identifier for a file: the prefix, the sanitized name cut to 52 characters and the first 8 hex digits
 * of the SHA-256 of the name, so names that sanitize alike stay apart. At most 72 characters.
 */
export function fileIdentifier(prefix: "Cmp" | "File", name: string): string {
  const digest = createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8);
  return prefix + "_" + sanitizeId(name).slice(0, 52) + "_" + digest;
}
