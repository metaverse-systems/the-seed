# @metaverse-systems/the-seed

A CLI tool and TypeScript library for scaffolding, building, and cross-compiling C++ ECS projects built on the libecs-cpp framework. It provides project templates, dependency management, native and Windows cross-compilation workflows, and a programmatic API for integration into custom tooling.

## Architecture

The project consists of four repositories with a linear dependency chain:

```text
libecs-cpp --> libthe-seed --> the-seed --> the-seed-vscode
```

**libecs-cpp** -- A C++20 Entity Component System framework providing Manager, Container, Entity, Component, System, Timing, and Uuid classes. Built with GNU Autotools and distributed via pkg-config as `ecs-cpp`.
GitHub: https://github.com/metaverse-systems/libecs-cpp

**libthe-seed** -- A C++20 engine runtime that depends on libecs-cpp. Provides LibraryLoader, ComponentLoader, SystemLoader, JSONLoader, ResourcePak, NameParser, and DependencyLister. Built with GNU Autotools and distributed via pkg-config as `the-seed`.
GitHub: https://github.com/metaverse-systems/libthe-seed

**the-seed** -- A TypeScript CLI tool and npm package (`@metaverse-systems/the-seed`) with a C++ N-API native addon (node-gyp). Wraps DependencyLister for shared library dependency analysis. Provides 7 CLI commands for scaffolding, building, and packaging.
GitHub: https://github.com/metaverse-systems/the-seed

**the-seed-vscode** -- A TypeScript VS Code extension that depends on `@metaverse-systems/the-seed`. Provides the "The Seed: Create ResourcePak" command for creating resource paks from within the editor.
GitHub: https://github.com/metaverse-systems/the-seed-vscode

## Prerequisites

### Required

- Node.js v16+ and npm

```bash
sudo apt install build-essential libtool pkg-config autoconf automake curl git
```

### Optional: Windows Cross-Compilation

These packages are only needed if you intend to cross-compile projects for Windows:

```bash
sudo apt install mingw-w64-x86-64-dev g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 wine wine64
```

### Optional: Windows MSI Installer Generation

To generate `.msi` installer packages from cross-compiled Windows binaries:

```bash
sudo apt install msitools
```

## Installation

```bash
npm install -g @metaverse-systems/the-seed
```

Verify the installation:

```bash
the-seed help
```

Expected output:

```text
Usage: the-seed <command>

Commands:
  config
  scopes
  template
  build
  dependencies
  package
  resource-pak
  signing
  installer
```

## Quick Start

### Step 1: Configure the installation prefix

```bash
the-seed config edit
```

```text
? Installation prefix? ~/the-seed
```

This creates `~/the-seed/config.json` with your chosen prefix.

### Step 2: Create a scope

```bash
the-seed scopes add
```

```text
? Name for scope? my-project
? Your name? Jane Developer
? Your email? jane@example.com
? Your URL? https://example.com
```

The scope `@my-project` is saved to your configuration.

### Step 3: Create a component from a template

```bash
the-seed template component
```

```text
? Choose scope for component: @my-project
? Choose name for component: hello-world
```

This creates the project directory at `~/the-seed/projects/@my-project/hello-world/` with autotools build files and a `package.json` containing build scripts.

### Step 4: Install dependencies

```bash
cd ~/the-seed/projects/@my-project/hello-world
the-seed dependencies install
```

```text
Checking ecs-cpp... not installed
Cloning libecs-cpp...
Building libecs-cpp...
Checking the-seed... not installed
Cloning libthe-seed...
Building libthe-seed...
```

This clones and builds the required C++ libraries into your prefix.

### Step 5: Build the project

```bash
the-seed build native
```

```text
Completed ./autogen.sh
Completed configure
Completed make
Completed make install
```

The compiled binary or library is installed to `~/the-seed/x86_64-linux-gnu/`.

## Directory Structure

After configuration and building, the installation prefix has the following layout:

```text
~/the-seed/
+-- config.json                    # Configuration file (prefix, scopes)
+-- include/                       # Shared headers
+-- projects/                      # Scaffolded projects organized by scope
|   +-- @scope-name/
|       +-- project-name/
+-- x86_64-linux-gnu/              # Native Linux target
|   +-- bin/                       # Compiled binaries
|   +-- lib/
|       +-- pkgconfig/             # pkg-config files
+-- x86_64-w64-mingw32/            # Windows cross-compilation target
    +-- bin/                       # Cross-compiled binaries
    +-- lib/
        +-- pkgconfig/             # pkg-config files
```

## CLI Reference

### config

Manage the-seed configuration.

| Subcommand | Description |
|------------|-------------|
| `list` | Print the path to `config.json` and its contents (default) |
| `edit` | Interactively set the installation prefix |
| `scopes list` | Print the list of configured scope names |
| `scopes help` | Print help for config scopes subcommands |

`the-seed config edit` prompts:

```text
? Installation prefix? ~/the-seed
```

If no `config.json` exists, `config list` suggests running `config edit`.

### scopes

Manage project scopes. Scopes group projects under a namespace (e.g., `@my-org`).

| Subcommand | Description |
|------------|-------------|
| `help` | Print all subcommands with descriptions (default) |
| `list` | Print configured scope names |
| `add` | Interactively create a new scope |
| `edit` | Interactively edit an existing scope |
| `delete` | Interactively delete a scope |

`the-seed scopes add` prompts:

```text
? Name for scope? my-project
? Your name? Jane Developer
? Your email? jane@example.com
? Your URL? https://example.com
```

Scope names are automatically prefixed with `@` if not already present.

`the-seed scopes edit` and `scopes delete` prompt you to select from existing scopes. If no scopes exist, an error message is printed.

### template

Scaffold new C++ projects from built-in templates.

| Subcommand | Description |
|------------|-------------|
| `help` | List available templates (default) |
| `component` | Create a new ECS component project |
| `system` | Create a new ECS system project |
| `program` | Create a new standalone program project |

All three template types prompt for a scope and a project name:

```text
? Choose scope for component: @my-project
? Choose name for component: hello-world
```

Template variable substitutions applied during scaffolding:

| Variable | Replaced With |
|----------|---------------|
| `SKELETON` | Project name |
| `SKELETON_` | Project name with `-` replaced by `_` |
| `AUTHOR_EMAIL` | Scope author email |
| `AUTHOR_URL` | Scope author URL |

The generated `package.json` includes build scripts:

```json
{
  "scripts": {
    "build": "the-seed build native",
    "build-win64": "the-seed build windows"
  }
}
```

The `component` and `system` templates include a `.pc.in` file for pkg-config. The `program` template does not.

### build

Build and cross-compile projects using GNU Autotools.

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | Print usage and available targets |
| `native` | | Full build for Linux (autogen, configure, make, install) |
| `native` | `recursive` | Build all transitive dependencies then the current project for Linux |
| `windows` | | Full cross-compile for Windows (autogen, configure with mingw host, make, install) |
| `windows` | `recursive` | Build all transitive dependencies then the current project for Windows |
| (none) | | Incremental build (make + make install only, no reconfigure) |

Target directory mapping:

| Target | Host Flag | Install Prefix |
|--------|-----------|----------------|
| `native` | (none) | `<prefix>/x86_64-linux-gnu` |
| `windows` | `--host=x86_64-w64-mingw32` | `<prefix>/x86_64-w64-mingw32` |

During `configure`, `PKG_CONFIG_PATH` is set to `<prefix>/<target>/lib/pkgconfig/` so that dependencies installed in the prefix are found.

Build steps for `native` and `windows`:

1. `./autogen.sh`
2. `make distclean` (errors ignored)
3. `./configure --prefix=<prefix>/<target> [--host=x86_64-w64-mingw32]`
4. `make -j`
5. `make install`

Running `the-seed build` without a subcommand performs only steps 4 and 5.

#### Recursive Builds

The `recursive` flag discovers all transitive `file:` and `node_modules` dependencies from `package.json`, classifies each project by type (component, system, or program), and builds them in topological order so that dependencies are always installed before their dependents.

```bash
the-seed build native recursive
```

Projects are classified by inspecting `src/Makefile.am`:

| Type | Detection | Build Priority |
|------|-----------|----------------|
| Component | `lib_LTLIBRARIES` without `the-seed` in name | 0 (first) |
| System | `lib_LTLIBRARIES` with `the-seed` in name | 1 |
| Program | `bin_PROGRAMS` | 2 (last) |

Within each tier, projects are sorted alphabetically. The build halts immediately if any project fails (unless the project's `ignoreExitCode` flag is set).

Cancellation is supported via `AbortSignal` when invoked programmatically.

### dependencies

Check and install C++ library dependencies (libecs-cpp and libthe-seed).

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | Print usage |
| `check` | `[target]` | Check if ecs-cpp and the-seed libraries are installed |
| `install` | `[target]` | Clone and build missing libraries from GitHub |

The `target` argument defaults to `native`. For each missing library, the `install` command clones the repository from GitHub and builds it with autotools into the target prefix:

- `ecs-cpp`: Cloned from `https://github.com/metaverse-systems/libecs-cpp.git`
- `the-seed`: Cloned from `https://github.com/metaverse-systems/libthe-seed.git`

Running an unknown subcommand prints "Invalid command" with a pointer to `help`.

### package

Create distributable packages by resolving binaries and their shared library dependencies.

```text
Usage: the-seed package <output-directory> <project-dir> [project-dir2] ...
```

| Argument | Description |
|----------|-------------|
| `output-directory` | Directory where resolved files are copied |
| `project-dir` | One or more project directories to package |

Behavior:

1. Validates that all directories exist
2. Parses `src/Makefile.am` for binary type (`bin_PROGRAMS` or `lib_LTLIBRARIES`)
3. Resolves compiled binaries from `src/.libs/`
4. Resolves transitive project dependencies from `package.json` and `node_modules`
5. Analyzes shared library dependencies using the native DependencyLister addon
6. Copies all resolved files to the output directory

Search paths for shared library resolution include `<prefix>/<target>/lib`, `<prefix>/<target>/bin`, and MinGW cross-compiler runtime directories.

### resource-pak

Create and manage resource pak files for bundling assets.

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | List subcommands (default) |
| `create` | | Interactively create a new resource pak project |
| `add` | `<resource-name> <filename>` | Add a resource entry to the current project |
| `build` | | Build a `.pak` file from the current project |

`the-seed resource-pak create` prompts:

```text
? Choose scope for resource pak: @my-project
? Choose name for resource pak: my-assets
```

This creates a project directory at `<prefix>/projects/<scope>/<name>/` with a `package.json` containing a `resources` array.

`the-seed resource-pak add <name> <filename>` reads `package.json` from the current directory and adds a resource entry with `name`, `filename`, and `size`. If a resource with the same name already exists, it is skipped.

`the-seed resource-pak build` reads `package.json` from the current directory and produces a `.pak` file. The file format consists of a JSON header (containing the name, a zero-padded 10-digit header size, and resource metadata) followed by a newline and the concatenated raw resource bytes.

### signing

Sign and verify project files and directories using ECDSA P-256 certificates.

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | Show signing subcommands (default) |
| `create-cert` | | Create a signing certificate for a scope |
| `sign` | `<file-or-dir>` | Sign a file or directory |
| `verify` | `<file-or-dir>` | Verify a signed file or directory |
| `cert-info` | | Display certificate information for a scope |

**Embedded signatures** are automatically applied when signing PE (`.exe`, `.dll`) and Mach-O binaries. The signature is stored inside the binary itself — no separate `.sig` file is created. For all other file types, a detached `.sig` file is produced.

Use `--detached` to force detached signatures even for PE and Mach-O files:

```bash
# Embedded (default for PE/Mach-O)
the-seed signing sign myapp.exe

# Detached (forced)
the-seed signing sign --detached myapp.exe

# Detached (default for non-binary files)
the-seed signing sign config.json
```

**Verification** auto-detects the signature type. Embedded signatures are checked first; if none is found, the verifier falls back to looking for a detached `.sig` file.

```bash
the-seed signing verify myapp.exe    # checks embedded Authenticode signature
the-seed signing verify config.json  # checks detached .sig file
```

**Directory signing** produces a `signing-manifest.json` (v2 format) with per-file `signatureType` entries:

```bash
the-seed signing sign ./dist
the-seed signing verify ./dist
```

Manifest v2 example:

```json
{
  "version": 2,
  "entries": [
    { "file": "myapp.exe", "signatureType": "embedded", "signatureFile": null, "signature": "SHA256:..." },
    { "file": "readme.txt", "signatureType": "detached", "signatureFile": "readme.txt.sig", "signature": "SHA256:..." }
  ]
}
```

### installer

Generate Windows `.msi` installer packages from cross-compiled binaries.

| Subcommand | Description |
|------------|-------------|
| `help` | Show usage and available targets (default) |
| `windows` | Generate a Windows MSI installer from `dist/` files |

**Prerequisites**: `msitools` must be installed (`sudo apt install msitools`).

**Usage**:

```bash
# Cross-compile your project for Windows first
the-seed build windows

# Package binaries into dist/
the-seed package dist .

# Generate the MSI installer
the-seed installer windows
```

**Output files** (in the project directory):

- `<name>-<version>.wxs` — WiX XML source (retained for inspection)
- `<name>-<version>.msi` — Windows Installer package

If `dist/` does not exist, the command automatically runs `the-seed package dist .` to populate it before generating the installer. The installer installs files to `C:\Program Files\<name>\` on Windows and uses a deterministic `UpgradeCode` derived from the project name for seamless major-upgrade behavior.

## API Reference

### Classes

#### Config

Manages the-seed configuration file.

```typescript
constructor(configDir?: string)
```

**Properties**:

| Property | Type | Description |
|----------|------|-------------|
| `configDir` | `string` | Path to the configuration directory (default: `~/the-seed`) |
| `configFile` | `string` | Configuration filename (`/config.json`) |
| `config` | `ConfigType` | The loaded configuration object |

**Methods**:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `loadConfig()` | `void` | Load configuration from disk; creates default if missing |
| `saveConfig()` | `void` | Write current configuration to disk |
| `getQuestions()` | `object[]` | Return inquirer prompt questions for configuration |
| `parseAnswers(answers: { prefix: string })` | `void` | Apply prompt answers to the configuration |

#### Scopes

Manages project scopes within the configuration.

```typescript
constructor(config: Config)
```

**Properties**:

| Property | Type | Description |
|----------|------|-------------|
| `config` | `Config` | The Config instance to read/write scopes from |

**Methods**:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `askWhichScope()` | `object[]` | Return inquirer prompt to select an existing scope |
| `askNewScope()` | `object[]` | Return inquirer prompts for creating a new scope |
| `askEditScope(defaults?: ScopeDefaultsType)` | `object[]` | Return inquirer prompts for editing a scope |
| `createOrEditScope(answers: ScopeAnswersType)` | `void` | Save a scope from prompt answers |
| `deleteScope(scope: string)` | `void` | Remove a scope from configuration |
| `getScopes()` | `string[]` | Return array of scope names |
| `getScope(scope: string)` | `ScopeType` | Return a specific scope by name |
| `getQuestions(defaults: { scopeName?: string })` | `object[]` | Return inquirer prompts with optional defaults |

#### Package

Resolves project binaries and their shared library dependencies for packaging.

```typescript
constructor(config: Config)
```

**Properties**:

| Property | Type | Description |
|----------|------|-------------|
| `config` | `Config` | The Config instance for prefix and target paths |

**Methods**:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `getSearchPaths()` | `string[]` | Return library search paths for the current target |
| `parseMakefileAm(projectDir: string)` | `{ type: "program" \| "library"; name: string } \| null` | Parse src/Makefile.am for binary type and name |
| `resolveBinaryPaths(projectDir: string)` | `string[]` | Resolve compiled binary paths from src/.libs/ |
| `getPackageDeps(projectDir: string, visited?: Set<string>)` | `string[]` | Recursively resolve project dependencies |
| `resolveDependencies(binaryPaths: string[], searchPaths: string[])` | `DependencyResultType` | Analyze shared library dependencies using native addon |
| `run(outputDir: string, projectDirs: string[])` | `void` | Execute full packaging workflow |

#### Signing

Sign and verify files using ECDSA P-256 certificates with support for embedded (PE Authenticode, Mach-O code signatures) and detached signatures.

```typescript
constructor(configDir?: string)
```

**Methods**:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `createCert(options?: { validityDays?: number; scope?: string })` | `Promise<CertInfo>` | Create a signing certificate for a scope |
| `hasCert(scope?: string)` | `boolean` | Check if a certificate exists |
| `getCertInfo(scope?: string)` | `CertInfo \| null` | Return certificate details |
| `detectBinaryFormat(filePath: string)` | `FormatDetectionResult` | Detect PE, Mach-O, or other format via magic bytes |
| `getSigningStrategy(filePath: string, options?: SignOptions)` | `SignatureType` | Return "embedded" or "detached" for a file |
| `signFile(filePath: string, options?: SignOptions)` | `Promise<SignResult>` | Sign a file (auto-detects format) |
| `signFileAuthenticode(filePath: string, scope: string)` | `Promise<SignResult>` | Embed an Authenticode signature in a PE binary |
| `signFileMachO(filePath: string, scope: string)` | `Promise<SignResult>` | Embed a code signature in a Mach-O binary |
| `signDirectory(dirPath: string, options?: SignOptions)` | `Promise<DirectorySignResult>` | Sign all files and produce a v2 manifest |
| `verifyFile(filePath: string)` | `Promise<VerifyResult>` | Verify a file (checks embedded first, then detached) |
| `verifyFileAuthenticode(filePath: string)` | `Promise<VerifyResult>` | Verify an embedded Authenticode signature |
| `verifyFileMachO(filePath: string)` | `Promise<VerifyResult>` | Verify an embedded Mach-O code signature |
| `verifyDirectory(dirPath: string)` | `Promise<DirectoryVerifyResult>` | Verify a directory against its signing manifest |

### Types

```typescript
interface AuthorType {
  name: string;
  email: string;
  url: string;
}

interface ConfigType {
  prefix: string;
  scopes: ScopesType;
}

interface ScopeType {
  author: AuthorType;
}

interface ScopesType {
  [index: string]: ScopeType;
}

interface ScopeAnswersType {
  scopeName: string;
  authorName: string;
  authorEmail: string;
  authorURL: string;
}

interface ScopeDefaultsType {
  name?: string;
  email?: string;
  url?: string;
}

interface ResourceType {
  name: string;
  filename: string;
  size: number;
  attributes?: { [key: string]: string };
}

interface PackageType {
  author: AuthorType;
  name: string;
  license: string;
  version: string;
  scripts: {
    [index: string]: string;
  };
  resources: ResourceType[];
  main?: string;
}

interface ScriptArgsType {
  binName: string;
  args: string[];
  configDir: string;
}

interface DependencyResultType {
  dependencies: Record<string, string[]>;
  errors: Record<string, string>;
}

type SignatureType = "embedded" | "detached";
type BinaryFormat = "pe" | "macho" | "other";

interface FormatDetectionResult {
  format: BinaryFormat;
  subFormat: "pe32" | "pe32+" | "macho32" | "macho64" | "fat" | null;
}

interface SignOptions {
  force?: boolean;
  scope?: string;
  detached?: boolean;
}

interface SignResult {
  filePath: string;
  signaturePath: string | null;  // null for embedded signatures
  fingerprint: string;
  signatureType: SignatureType;
  warnings: string[];
}

interface VerifyResult {
  valid: boolean;
  filePath: string;
  error?: string;
  fingerprint?: string;
  signatureType?: SignatureType;
  warnings?: string[];
}
```

### Import Example

```typescript
import {
  Config,
  Scopes,
  Package,
  Signing,
  AuthorType,
  ConfigType,
  ScopeType,
  ScopesType,
  ScopeAnswersType,
  ScopeDefaultsType,
  ResourceType,
  PackageType,
  ScriptArgsType,
  DependencyResultType,
  SignatureType,
  BinaryFormat,
  FormatDetectionResult,
  SignOptions,
  SignResult,
  VerifyResult
} from "@metaverse-systems/the-seed";

// Initialize configuration
const config = new Config();

// List all scopes
const scopes = new Scopes(config);
console.log(scopes.getScopes());

// Package a project
const pkg = new Package(config);
pkg.run("./output", ["./my-project"]);

// Sign a binary (auto-detects PE/Mach-O for embedded, detached for others)
const signing = new Signing();
const result = await signing.signFile("./dist/myapp.exe", { scope: "@my-project" });
console.log(result.signatureType); // "embedded"

// Verify a signed file
const verify = await signing.verifyFile("./dist/myapp.exe");
console.log(verify.valid, verify.signatureType); // true "embedded"
```

## License

MIT -- See [LICENSE](LICENSE) for details.

## Author

Tim Schwartz <tim@metaverse.systems>
