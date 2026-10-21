import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import Config from "./Config";
import { buildWindowsHint } from "./cli/Hints";
import Package from "./Package";
import { NativeComponentMissingError, requireNativeComponent } from "./NativeComponent";
import {
  InstallerMetadataError,
  checkFolderName,
  fileIdentifier,
  installerVersion,
  parsePackageVersion,
  sanitizeId,
  xmlAttribute,
} from "./InstallerMetadata";

export interface InstallerConfig {
  productName: string;
  version: string;        // Installer version: three numbers, X.Y.Z
  packageVersion: string; // The package's own version, as written in package.json
  manufacturer: string;
  upgradeCode: string;   // Uppercase UUID
}

// Hardcoded namespace UUID for the-seed installer UpgradeCodes.
// Generated once; never change this value.
const INSTALLER_NAMESPACE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

export { sanitizeId };

/** What `Installer.run` resolves: the installer, or the status and message of the failure (already printed). */
export type InstallerRunResult =
  | { ok: true; msiPath: string }
  | { ok: false; status: 1 | 2; message: string };

/** What `Installer.readProjectMetadata` returns; nothing is printed. */
export type ProjectMetadataResult =
  | { ok: true; config: InstallerConfig; notes: string[] }
  | { ok: false; message: string; status: 2 };

/**
 * Generate a deterministic UUID v5 (SHA-1 namespace-based) UpgradeCode
 * from a product name. Same name always produces the same GUID.
 */
export function generateUpgradeCode(productName: string): string {
  const namespaceBytes = Buffer.from(
    INSTALLER_NAMESPACE.replace(/-/g, ""), "hex"
  );
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(productName, "utf8")
    .digest();

  // Set version bits (0101 = v5)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant bits (10xx)
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.subarray(0, 16).toString("hex").toUpperCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

class Installer {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  /**
   * Check whether wixl is installed on the system.
   * Returns true if wixl is found on PATH.
   */
  checkWixl = (): boolean => {
    try {
      execFileSync("which", ["wixl"], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Read project metadata from package.json and return an InstallerConfig with the notes to show the user.
   * Every check is made here, before anything is written, and nothing is printed: a refusal comes back as
   * `{ ok: false, message, status: 2 }`.
   */
  readProjectMetadata = (projectDir: string): ProjectMetadataResult => {
    const refuse = (message: string): ProjectMetadataResult => ({ ok: false, message, status: 2 });
    const pkgPath = path.join(projectDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      return refuse("package.json not found in " + projectDir);
    }

    let pkgData: Record<string, unknown>;
    try {
      pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    } catch (err) {
      return refuse("Failed to parse package.json: " + (err instanceof Error ? err.message : String(err)));
    }
    if (pkgData === null || typeof pkgData !== "object") {
      return refuse("Failed to parse package.json: it does not hold an object");
    }

    const rawName = pkgData.name;
    if (!rawName || typeof rawName !== "string") {
      return refuse("package.json must contain a non-empty 'name' field");
    }

    // Strip npm scope prefix (e.g. "@metaverse-systems/client" → "client")
    const name = rawName.startsWith("@") && rawName.includes("/")
      ? rawName.split("/").pop()!
      : rawName;

    const rawVersion = pkgData.version;
    if (!rawVersion || typeof rawVersion !== "string") {
      return refuse("package.json must contain a valid 'version' field");
    }

    // Extract author — handle both string and object forms
    let manufacturer = "Unknown";
    const author = pkgData.author;
    if (typeof author === "string") {
      manufacturer = author || "Unknown";
    } else if (author !== null && typeof author === "object" && typeof (author as { name?: unknown }).name === "string" && (author as { name: string }).name) {
      manufacturer = (author as { name: string }).name;
    }

    try {
      checkFolderName(name);
      const installer = installerVersion(parsePackageVersion(rawVersion));
      // Use the full scoped name for UpgradeCode to keep it deterministic per package
      const config: InstallerConfig = {
        productName: name,
        version: installer.version,
        packageVersion: rawVersion,
        manufacturer,
        upgradeCode: generateUpgradeCode(rawName),
      };
      // Dry run: every value written to the description must be one XML can carry
      xmlAttribute(config.productName);
      xmlAttribute(config.manufacturer);
      xmlAttribute(config.version);
      return { ok: true, config, notes: installer.note === null ? [] : [installer.note] };
    } catch (err) {
      if (err instanceof InstallerMetadataError) {
        return refuse(err.message);
      }
      throw err;
    }
  };

  /**
   * Ensure the dist/ directory of the project exists. If missing, packages the project into it
   * (the project's own dist/, whatever the working directory is). When packaging is refused,
   * for example for a name collision, the refusal is printed and no installer is built.
   * Resolves true if dist/ exists and is non-empty after this call.
   */
  ensureDist = async (projectDir: string): Promise<boolean> => {
    return (await this.prepareDist(projectDir)) === null;
  };

  /**
   * Does the work of ensureDist, printing what it reports. Resolves null on success, otherwise the final
   * message it printed.
   */
  private prepareDist = async (projectDir: string): Promise<string | null> => {
    const distDir = path.join(projectDir, "dist");
    const fail = (message: string): string => {
      console.error("Error: " + message);
      return message;
    };

    if (!fs.existsSync(distDir)) {
      console.log("dist/ not found, running package step...");
      try {
        const pkg = new Package(this.config);
        const result = await pkg.run(distDir, [projectDir]);
        if (!result.success) {
          if (result.message !== null && result.message.startsWith("No installed binaries found for")) {
            console.error(buildWindowsHint());
          }
          return fail("Packaging failed; no installer was built.");
        }
      } catch (err) {
        return fail("Packaging failed: " + (err instanceof Error ? err.message : String(err)));
      }
    }

    // Verify dist/ is non-empty
    if (!fs.existsSync(distDir)) {
      return fail("dist/ directory does not exist after packaging.");
    }

    if (this.listDistFiles(projectDir).length === 0) {
      return fail("dist/ directory is empty.");
    }

    return null;
  };

  private listDistFiles = (projectDir: string): string[] => {
    const distDir = path.join(projectDir, "dist");
    return fs.readdirSync(distDir).filter(f => fs.statSync(path.join(distDir, f)).isFile());
  };

  /**
   * Generate WiX XML content and write a .wxs file to the project directory.
   * Returns the path to the generated .wxs file.
   */
  generateWxs = (projectDir: string, config: InstallerConfig, files: string[]): string => {
    const productName = xmlAttribute(config.productName);
    const manufacturer = xmlAttribute(config.manufacturer);
    const version = xmlAttribute(config.version);

    // Every file has its own identifiers; two files that would share one are refused, never merged
    const owners = new Map<string, string>();
    const entries = files.map(filename => {
      const componentId = fileIdentifier("Cmp", filename);
      const fileId = fileIdentifier("File", filename);
      const other = owners.get(componentId);
      if (other !== undefined) {
        throw new InstallerMetadataError("The files \"" + other + "\" and \"" + filename + "\" would get the same installer identifier.");
      }
      owners.set(componentId, filename);
      return { componentId, fileId, name: xmlAttribute(filename), source: xmlAttribute("dist/" + filename) };
    });

    const components = entries.map(entry => {
      return `          <Component Id="${entry.componentId}" Guid="*" Win64="yes">
            <File Id="${entry.fileId}"
                  Name="${entry.name}"
                  Source="${entry.source}"
                  KeyPath="yes" />
          </Component>`;
    }).join("\n");

    const componentRefs = entries.map(entry => `      <ComponentRef Id="${entry.componentId}" />`).join("\n");

    const wxs = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">

  <Product Id="*"
           Name="${productName}"
           Language="1033"
           Version="${version}"
           Manufacturer="${manufacturer}"
           UpgradeCode="${config.upgradeCode}">

    <Package InstallerVersion="200"
             Compressed="yes"
             InstallScope="perMachine"
             Platform="x64" />

    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />

    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="${productName}">
${components}
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="ProductFeature" Title="${productName}" Level="1">
${componentRefs}
    </Feature>

  </Product>
</Wix>
`;

    const wxsFilename = `${config.productName}-${config.packageVersion}.wxs`;
    const wxsPath = path.join(projectDir, wxsFilename);
    fs.writeFileSync(wxsPath, wxs, "utf-8");
    return wxsPath;
  };

  /**
   * Invoke wixl to compile the .wxs file into an .msi.
   * Returns true on success.
   */
  compileMsi = (projectDir: string, wxsPath: string, outputPath: string): boolean => {
    return this.compile(projectDir, wxsPath, outputPath) === null;
  };

  /** Does the work of compileMsi, printing what it reports. Resolves null on success, otherwise the message it printed. */
  private compile = (projectDir: string, wxsPath: string, outputPath: string): string | null => {
    try {
      execFileSync("wixl", ["-v", "-a", "x64", "-o", outputPath, wxsPath], {
        cwd: projectDir,
        stdio: "pipe"
      });
      return null;
    } catch (err) {
      let message: string;
      const signal = err && typeof err === "object" && "signal" in err ? (err as { signal?: string | null }).signal : null;
      if (signal) {
        message = "Error: wixl was killed by signal " + signal + " while compiling the installer";
      } else if (err && typeof err === "object" && "stderr" in err) {
        const stderr = (err as { stderr: Buffer }).stderr;
        message = "Error: wixl compilation failed:\n" + stderr.toString();
      } else {
        message = "Error: wixl compilation failed: " + (err instanceof Error ? err.message : String(err));
      }
      console.error(message);
      return message;
    }
  };

  /**
   * Full pipeline: component check → wixl check → metadata → ensure dist → generate → compile.
   * Resolves the path of the installer, or the status and message of the failure; each message is printed
   * once, here. Status 2 is for something missing or unusable, 1 for packaging or compilation that failed.
   */
  run = async (projectDir: string): Promise<InstallerRunResult> => {
    const failure = (status: 1 | 2, message: string, printed = false): InstallerRunResult => {
      if (!printed) {
        console.error(message);
      }
      return { ok: false, status, message };
    };

    // The installer is built from the packaged files, which needs the native component
    try {
      requireNativeComponent();
    } catch (err) {
      if (err instanceof NativeComponentMissingError) {
        return failure(2, err.message);
      }
      throw err;
    }

    // Step 1: Validate wixl is installed
    if (!this.checkWixl()) {
      return failure(2, "Error: wixl is not installed. Install it with: sudo apt install wixl");
    }

    // Step 2: Read project metadata
    const metadata = this.readProjectMetadata(projectDir);
    if (!metadata.ok) {
      return failure(2, "Error: " + metadata.message);
    }
    for (const note of metadata.notes) {
      console.log(note);
    }

    // Step 3: Ensure dist/ directory
    const distFailure = await this.prepareDist(projectDir);
    if (distFailure !== null) {
      return failure(1, distFailure, true);
    }

    // Step 4: Read dist/ contents
    const files = this.listDistFiles(projectDir);

    // Step 5: Generate .wxs file
    console.log("Generating WiX XML source...");
    let wxsPath: string;
    try {
      wxsPath = this.generateWxs(projectDir, metadata.config, files);
    } catch (err) {
      if (err instanceof InstallerMetadataError) {
        return failure(2, "Error: " + err.message);
      }
      throw err;
    }
    console.log("Generated: " + path.basename(wxsPath));

    // Step 6: Invoke wixl
    const msiFilename = `${metadata.config.productName}-${metadata.config.packageVersion}.msi`;
    const msiPath = path.join(projectDir, msiFilename);
    console.log("Compiling MSI installer...");
    const compileError = this.compile(projectDir, wxsPath, msiPath);
    if (compileError !== null) {
      return failure(1, compileError, true);
    }

    // Step 7: Success
    console.log("Installer created: " + msiFilename);
    return { ok: true, msiPath };
  };
}

export default Installer;
