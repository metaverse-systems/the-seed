import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import Config from "./Config";
import Package from "./Package";

export interface InstallerConfig {
  productName: string;
  version: string;       // 4-part: X.X.X.0
  manufacturer: string;
  upgradeCode: string;   // Uppercase UUID
}

// Hardcoded namespace UUID for the-seed installer UpgradeCodes.
// Generated once; never change this value.
const INSTALLER_NAMESPACE = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

/**
 * Sanitize a filename for use as a WiX XML Id attribute.
 * Replaces non-alphanumeric characters (except underscores) with underscores,
 * and prefixes with '_' if the name starts with a digit.
 */
export function sanitizeId(name: string): string {
  let id = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(id)) {
    id = "_" + id;
  }
  return id;
}

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
   * Read project metadata from package.json and return an InstallerConfig.
   * Returns null if package.json is missing or invalid.
   */
  readProjectMetadata = (projectDir: string): InstallerConfig | null => {
    const pkgPath = path.join(projectDir, "package.json");
    if (!fs.existsSync(pkgPath)) {
      console.error("Error: package.json not found in " + projectDir);
      return null;
    }

    try {
      const pkgData = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));

      const rawName = pkgData.name;
      if (!rawName || typeof rawName !== "string") {
        console.error("Error: package.json must contain a non-empty 'name' field");
        return null;
      }

      // Strip npm scope prefix (e.g. "@metaverse-systems/client" → "client")
      const name = rawName.startsWith("@") && rawName.includes("/")
        ? rawName.split("/").pop()!
        : rawName;

      const rawVersion = pkgData.version;
      if (!rawVersion || typeof rawVersion !== "string") {
        console.error("Error: package.json must contain a valid 'version' field");
        return null;
      }

      // Convert 3-part semver to 4-part for WiX
      const versionParts = rawVersion.split(".");
      const version = versionParts.length === 3
        ? rawVersion + ".0"
        : rawVersion;

      // Extract author — handle both string and object forms
      let manufacturer = "Unknown";
      if (pkgData.author) {
        if (typeof pkgData.author === "string") {
          manufacturer = pkgData.author || "Unknown";
        } else if (typeof pkgData.author === "object" && pkgData.author.name) {
          manufacturer = pkgData.author.name;
        }
      }

      // Use the full scoped name for UpgradeCode to keep it deterministic per package
      const upgradeCode = generateUpgradeCode(rawName);

      return { productName: name, version, manufacturer, upgradeCode };
    } catch (err) {
      console.error("Error: Failed to parse package.json: " + (err instanceof Error ? err.message : String(err)));
      return null;
    }
  };

  /**
   * Ensure the dist/ directory exists. If missing, auto-runs Package.run('dist', ['.']).
   * Returns true if dist/ exists and is non-empty after this call.
   */
  ensureDist = (projectDir: string): boolean => {
    const distDir = path.join(projectDir, "dist");

    if (!fs.existsSync(distDir)) {
      console.log("dist/ not found, running package step...");
      try {
        const pkg = new Package(this.config);
        const success = pkg.run("dist", [projectDir]);
        if (!success) {
          console.error("Error: Packaging failed. Ensure the project has been cross-compiled with 'the-seed build windows'.");
          return false;
        }
      } catch (err) {
        console.error("Error: Packaging failed: " + (err instanceof Error ? err.message : String(err)));
        return false;
      }
    }

    // Verify dist/ is non-empty
    if (!fs.existsSync(distDir)) {
      console.error("Error: dist/ directory does not exist after packaging.");
      return false;
    }

    const files = fs.readdirSync(distDir).filter(f => {
      const stat = fs.statSync(path.join(distDir, f));
      return stat.isFile();
    });

    if (files.length === 0) {
      console.error("Error: dist/ directory is empty.");
      return false;
    }

    return true;
  };

  /**
   * Generate WiX XML content and write a .wxs file to the project directory.
   * Returns the path to the generated .wxs file.
   */
  generateWxs = (projectDir: string, config: InstallerConfig, files: string[]): string => {
    const components = files.map(filename => {
      const safeId = sanitizeId(filename);
      return `          <Component Id="Cmp_${safeId}" Guid="*" Win64="yes">
            <File Id="File_${safeId}"
                  Name="${filename}"
                  Source="dist/${filename}"
                  KeyPath="yes" />
          </Component>`;
    }).join("\n");

    const componentRefs = files.map(filename => {
      const safeId = sanitizeId(filename);
      return `      <ComponentRef Id="Cmp_${safeId}" />`;
    }).join("\n");

    const wxs = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">

  <Product Id="*"
           Name="${config.productName}"
           Language="1033"
           Version="${config.version}"
           Manufacturer="${config.manufacturer}"
           UpgradeCode="${config.upgradeCode}">

    <Package InstallerVersion="200"
             Compressed="yes"
             InstallScope="perMachine"
             Platform="x64" />

    <MajorUpgrade DowngradeErrorMessage="A newer version of [ProductName] is already installed." />

    <Media Id="1" Cabinet="product.cab" EmbedCab="yes" />

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="${config.productName}">
${components}
        </Directory>
      </Directory>
    </Directory>

    <Feature Id="ProductFeature" Title="${config.productName}" Level="1">
${componentRefs}
    </Feature>

  </Product>
</Wix>
`;

    const wxsFilename = `${config.productName}-${config.version}.wxs`;
    const wxsPath = path.join(projectDir, wxsFilename);
    fs.writeFileSync(wxsPath, wxs, "utf-8");
    return wxsPath;
  };

  /**
   * Invoke wixl to compile the .wxs file into an .msi.
   * Returns true on success.
   */
  compileMsi = (projectDir: string, wxsPath: string, outputPath: string): boolean => {
    try {
      execFileSync("wixl", ["-v", "-a", "x64", "-o", outputPath, wxsPath], {
        cwd: projectDir,
        stdio: "pipe"
      });
      return true;
    } catch (err) {
      if (err && typeof err === "object" && "stderr" in err) {
        const stderr = (err as { stderr: Buffer }).stderr;
        console.error("Error: wixl compilation failed:\n" + stderr.toString());
      } else {
        console.error("Error: wixl compilation failed: " + (err instanceof Error ? err.message : String(err)));
      }
      return false;
    }
  };

  /**
   * Full pipeline: validate → ensure dist → generate → compile.
   * Returns true on success.
   */
  run = (projectDir: string): boolean => {
    // Step 1: Validate wixl is installed
    if (!this.checkWixl()) {
      console.error("Error: wixl is not installed. Install it with: sudo apt install msitools");
      return false;
    }

    // Step 2: Read project metadata
    const metadata = this.readProjectMetadata(projectDir);
    if (!metadata) {
      return false;
    }

    // Step 3: Ensure dist/ directory
    if (!this.ensureDist(projectDir)) {
      return false;
    }

    // Step 4: Read dist/ contents
    const distDir = path.join(projectDir, "dist");
    const files = fs.readdirSync(distDir).filter(f => {
      const stat = fs.statSync(path.join(distDir, f));
      return stat.isFile();
    });

    if (files.length === 0) {
      console.error("Error: dist/ directory is empty.");
      return false;
    }

    // Step 5: Generate .wxs file
    console.log("Generating WiX XML source...");
    const wxsPath = this.generateWxs(projectDir, metadata, files);
    console.log("Generated: " + path.basename(wxsPath));

    // Step 6: Invoke wixl
    const msiFilename = `${metadata.productName}-${metadata.version}.msi`;
    const msiPath = path.join(projectDir, msiFilename);
    console.log("Compiling MSI installer...");
    if (!this.compileMsi(projectDir, wxsPath, msiPath)) {
      return false;
    }

    // Step 7: Success
    console.log("Installer created: " + msiFilename);
    return true;
  };
}

export default Installer;
