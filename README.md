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
Installing libecs-cpp...
==> clone libecs-cpp: git clone https://github.com/metaverse-systems/libecs-cpp.git libecs-cpp
Cloning into 'libecs-cpp'...
==> libecs-cpp autogen: ./autogen.sh
...
==> libecs-cpp configure: ./configure --prefix=/home/you/the-seed/x86_64-linux-gnu
...
==> libecs-cpp compile: make -j8
...
==> libecs-cpp install: make install
...
libecs-cpp installed successfully.
Installing libthe-seed...
==> clone libthe-seed: git clone https://github.com/metaverse-systems/libthe-seed.git libthe-seed
...
libthe-seed installed successfully.
```

This clones and builds the required C++ libraries into your prefix. Each step is printed as `==> <label>: <command>`, followed by the program's own output as it happens. The compile step uses the processor count as its job limit (`8` above).

### Step 5: Build the project

```bash
the-seed build native
```

```text
==> autogen: ./autogen.sh
...
==> distclean: make distclean
...
==> configure: ./configure --prefix=/home/you/the-seed/x86_64-linux-gnu
...
==> compile: make -j8
...
==> install: make install
...
```

Each block is a step's label and command, followed by the program's output as it happens; `...` stands for that output.

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

The first command that needs configuration creates `~/the-seed/config.json` with the defaults (the prefix `~/the-seed` and no scopes), so there is no setup step before `config list`, `scopes add` or `build`. Entries missing from the file are filled in with their defaults. An entry of the wrong kind (for example a `prefix` that is not text), a file that is not valid JSON, or a directory that cannot be written stops the command with one line naming the file and the entry; the file is never rewritten to repair it. `config edit` and the other commands that save the configuration write it atomically.

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

```text
the-seed build <target> [--recursive] [--parallel N] [--jobs N] [--release]
the-seed build [--jobs N]
```

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | Print usage, options and examples |
| `native` | | Full build for Linux (autogen, configure, make, install) |
| `native` | `--recursive` | Build all transitive dependencies then the current project for Linux |
| `windows` | | Full cross-compile for Windows (autogen, configure with mingw host, make, install) |
| `windows` | `--recursive` | Build all transitive dependencies then the current project for Windows |
| (none) | | Incremental build (make + make install only, no reconfigure) |

Options go after the target, in any order:

| Option | Description |
|--------|-------------|
| `--recursive` | Build every buildable dependency first, then the current project (see [Recursive Builds](#recursive-builds)) |
| `--parallel N` | With `--recursive`, build up to `N` independent projects at once. Default 1. Also accepted as `--parallel=N`. `N` must be a positive whole number; values above the processor count are reduced to it |
| `--jobs N` | Run at most `N` compile jobs at once (`make -j<N>`). Default: the processor count. Also accepted as `--jobs=N`. `N` must be a positive whole number; a value above the processor count is allowed. With `--parallel`, it is the budget the projects building at once share |
| `--release` | Strip the installed programs and shared libraries, and the build-tree copies that `package` reads, before they are signed |

`--parallel=N` and `--jobs=N` are the same as `--parallel N` and `--jobs N`.

Any other argument is rejected with exit status 1 and a message naming it, before anything is built. That includes a misspelled option (`--recursve`), `--parallel` without `--recursive`, an invalid or repeated `--parallel` or `--jobs` value, an option given without a target (`the-seed build --release`) and an unknown target. `the-seed build --jobs N` is the one option accepted without a target.

Target directory mapping:

| Target | Host Flag | Install Prefix |
|--------|-----------|----------------|
| `native` | (none) | `<prefix>/x86_64-linux-gnu` |
| `windows` | `--host=x86_64-w64-mingw32` | `<prefix>/x86_64-w64-mingw32` |

During `configure`, and when `dependencies check` and `dependencies install` look for a library, pkg-config searches these places:

| Target | Searched |
|--------|----------|
| `native` | `<prefix>/x86_64-linux-gnu/lib/pkgconfig` first, then your own `PKG_CONFIG_PATH`, then pkg-config's default directories |
| `windows` | Only `<prefix>/x86_64-w64-mingw32/lib/pkgconfig`, `/usr/local/x86_64-w64-mingw32/lib/pkgconfig` and `/usr/x86_64-w64-mingw32/lib/pkgconfig` (`PKG_CONFIG_LIBDIR`). Your `PKG_CONFIG_PATH` and the system directories are not used, so a library built only for Linux can never satisfy a Windows build |

A library description that does not depend on the architecture, such as `nlohmann_json.pc`, is installed once in a system directory and so is not found for a Windows build; install it into the Windows prefix (`<prefix>/x86_64-w64-mingw32/lib/pkgconfig`) to make it visible.

The output of a plain or incremental build is shown as it happens, one `==> <label>: <command>` line per step. Paths are passed to every program exactly as they are, so a prefix or project directory may contain spaces, quotes or `$`. When a step fails, the build stops with a message naming the step and how it ended, and exits with status 1.

Build steps for `native` and `windows`:

1. `./autogen.sh`
2. `make distclean` (errors ignored)
3. `./configure --prefix=<prefix>/<target> [--host=x86_64-w64-mingw32]`
4. `make -j<jobs>` (the processor count unless `--jobs` is given)
5. `make install DESTDIR=<prefix>/.the-seed-staging/<random>`

Then the install phase:

1. Identify the programs and shared libraries the install step wrote: ELF executables and shared objects for `native`, PE programs and DLLs for `windows`. Archives, import libraries, `.la` files, wrappers, scripts, headers, `.pc` files and data are not processed.
2. Find the matching copies in `src/.libs/` (else `src/`), which `package` reads.
3. Strip both (with `--release`).
4. Sign both when the scope has a valid certificate.
5. Place the staged files into `<prefix>/<target>`.
6. Remove the staging directory.

**Changed:** earlier versions ran an unbounded `make -j`, which starts one compiler per source file and can exhaust memory. Every build now has a job limit.

Running `the-seed build` without a subcommand performs only steps 4 and 5 and the install phase.

**Changed:** earlier versions stripped and signed only the copies in the build tree; the files in the prefix were neither stripped nor signed, static archives and the Windows libtool wrapper were signed, and signing errors were ignored.

#### What is installed, stripped and signed

- Detached signatures for Linux outputs are written beside the installed file and beside each of its link names (`libx.so.sig` is a link to `libx.so.0.0.0.sig`); signatures for Windows outputs are embedded in the file.
- Signing happens on every kind of build. Stripping needs `--release` and a target (an incremental build with no target does not strip).
- When the project has programs or libraries to sign but cannot sign them (no `package.json`, no scope in the package name, no certificate for the scope, or an expired one), the build prints one line saying why (for example `Not signed: no signing certificate for scope '@t'. Create one with "the-seed signing create-cert".`), installs the files unsigned and removes any signature left beside them by an earlier build. An unreadable certificate or a file that cannot be stripped or signed fails the build.
- All or nothing: the prefix is changed only after every file has been stripped and signed. A failure at `install`, `strip`, `sign` or `place` leaves the prefix as it was.
- Cancelling: the first Ctrl+C lets the install phase finish and place its files (`Build cancelled after installing.`); a second Ctrl+C, `SIGTERM` or `SIGHUP` discards an install phase that has not reached placement (`Build cancelled.`). Placement, once started, completes.
- `<prefix>/.the-seed-staging` holds the staging directories while a build runs. It may be deleted when no build is running.
- A build refuses to install (failing at `install`) when `make install` writes outside the prefix, writes nothing, or the project was configured for another prefix; run a full build (`the-seed build <target>`) in that case.
- Files that an install rule deletes (for example retired headers) are not removed from the prefix, because the install writes into a staging directory.
- Outputs installed outside `src/` and `src/.libs/` are processed in the prefix, but their build-tree copies are not.

#### Recursive Builds

The `--recursive` option discovers all transitive `file:` and `node_modules` dependencies from `package.json`, classifies each project by type (component, system, or program), and builds them in topological order so that dependencies are always installed before their dependents.

```bash
the-seed build native --recursive
the-seed build windows --recursive --release
the-seed build native --recursive --parallel 4 --release
the-seed build native --recursive --jobs 4
```

Projects are classified by inspecting `src/Makefile.am`:

| Type | Detection | Build Priority |
|------|-----------|----------------|
| Component | `lib_LTLIBRARIES` without `the-seed` in name | 0 (first) |
| System | `lib_LTLIBRARIES` with `the-seed` in name | 1 |
| Program | `bin_PROGRAMS` | 2 (last) |

Within each tier, projects are sorted alphabetically.

By default (`--parallel 1`) projects build one at a time in that order, with the same commands as a plain build, including its job limit. With `--parallel N`, up to `N` projects build at once (never more than the processor count), and the ordering guarantees still hold:

- A project starts only after each of its dependencies has finished installing.
- Every component finishes before any system starts, and every system before any program. A project that depends on a higher tier than its own waits with that tier.
- Among projects that are ready, the one earliest in the build order starts first.
- Install phases never overlap. Each project's install phase (staged `make install`, strip with `--release`, signing, placement) runs as one unit that no other project's install phase can interleave with; a dependent starts only after its dependency's processed files are in the prefix.
- When more than one project builds at once, each tier's projects share the processors as `make -j<jobs>`, so the compile jobs running at once never add up to more than `--jobs`, or the processor count when `--jobs` is not given. `MAKEFLAGS` and `MFLAGS` are removed from the build environment so an inherited `-j` cannot override the share.

Every progress line names its project, for example `[@org/physics-system] compile... done`. Build output is captured, not streamed; when the build ends, a report lists the projects that completed, failed, were interrupted or never started, and each failure's full output appears as one block between `===== <project> failed at <step> =====` and `===== end of <project> output =====`.

The build stops starting new projects at the first failure; projects already building run to the end and are reported. A failed build exits with status 1.

Cancelling:

- The first Ctrl+C stops every running autogen, distclean, configure and compile step, and starts nothing new. An install phase already in progress finishes and places its files, so the prefix is never left half-written.
- A second Ctrl+C also stops an install phase that has not reached placement and discards it; that project is reported as interrupted. Placement, once started, completes.
- `SIGTERM` and `SIGHUP` act like two presses.
- A cancelled build exits with 130 after Ctrl+C, 143 after `SIGTERM` and 129 after `SIGHUP`.

When invoked programmatically, `buildRecursive` accepts an `AbortSignal` (`signal`, the graceful kind) and an optional `forceSignal`; cancelling from the VS Code extension is always the graceful kind.

The bare word `recursive` (without dashes) is deprecated. It still requests a recursive build but prints a warning; use `--recursive` instead.

### dependencies

Check and install C++ library dependencies (libecs-cpp and libthe-seed).

| Subcommand | Arguments | Description |
|------------|-----------|-------------|
| `help` | | Print usage |
| `check` | `[target]` | Check if ecs-cpp and the-seed libraries are installed |
| `install` | `[target]` | Clone and build missing libraries from GitHub |

The `target` argument is `native` or `windows` (anything else is rejected with exit status 1) and defaults to `native`. For each missing library, the `install` command clones the repository from GitHub and builds it with autotools into the target prefix. Each step is printed as `==> <label>: <command>` with the program's output as it happens. The compile step uses the processor count as its job limit (it used a plain `make` before); `dependencies install` has no `--jobs` option. A step that fails stops that library's install and the failure is reported:

- `ecs-cpp`: Cloned from `https://github.com/metaverse-systems/libecs-cpp.git`
- `the-seed`: Cloned from `https://github.com/metaverse-systems/libthe-seed.git`

Minimum versions are libecs-cpp 2.1.0 and libthe-seed 0.8.0. An installed copy older than its minimum is treated as missing and reinstalled; if the clone directory already exists it is updated first with `git pull --ff-only`, and the install fails naming the directory when that update fails. Projects generated by earlier versions keep their unversioned `the-seed` line in `configure.ac`; new projects ask for `the-seed >= 0.8.0`.

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
3. Resolves compiled binaries from `src/.libs/` (the build strips them with `--release` and signs them when the scope has a certificate)
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

**Embedded signatures** are automatically applied when signing PE (`.exe`, `.dll`) and Mach-O binaries and Windows installers (`.msi`). The signature is stored inside the binary itself — no separate `.sig` file is created. For all other file types, a detached `.sig` file is produced.

**Mac programs.** `sign` handles 64-bit little-endian arm64 and x86-64 programs, alone or in a universal file (every slice is signed, or none). The page fingerprints are computed over the finished file, so the order is fixed: the library prepares the layout and returns the CodeDirectory of each slice, the-seed signs each one with the scope's key, and the library writes the result in one step. Signing an already signed program replaces its signature in place (the warning "Replaced existing embedded signature" is shown) and the file does not grow. When something cannot be signed the command prints the library's message, exits non-zero and leaves the file as it was:

* No room for the signature command: `<path>: no room for the code signature command: 16 bytes needed, <n> available ...; relink with extra header space (for example -headerpad 0x20)`.
* Big-endian or 32-bit programs, or a universal file with such a slice: `<path>: <kind> Mac programs are not supported (supported: 64-bit little-endian arm64 and x86-64, alone or in a universal file)`.
* Data after the existing signature: the file is refused.

What was checked: page fingerprints in a signature produced by this library match the finished file (an independent checker and values recorded from Python's hashlib); the checker accepts the ad-hoc signature written by ld64.lld, a different producer; the structure of signed files parses with llvm-otool, llvm-objdump and llvm-lipo.

Nobody has checked a signature produced by this library with the platform's own verifier (`codesign --verify`) or by running a signed program on a Mac. What was checked is described above. The CMS part of the signature is the minimal one the-seed has always produced and is not known to be accepted by Apple's tools. Programs signed by earlier versions of the-seed are malformed after re-signing and may need to be rebuilt from their unsigned originals: rebuild from the unsigned original, then sign again.

Version 1.10.0 also fixes `_buildMachOCms`, which wrote the signature OCTET STRING length as a single byte; it now uses the DER length encoding, so signatures of 128 bytes or more are no longer malformed. The addon exports `machoComputeCodeDirectory` and `machoEmbedSignature` were removed (they always throw); see `structure.md` for the new exports.

**Windows installers.** `sign` embeds the signature of a `.msi` package into its `\x05DigitalSignature` stream. The package fingerprint is computed by libthe-seed by the rule osslsigncode uses, the signature is written, and the command then reads it back from the finished file: success is reported only when the stored fingerprint equals the package's. A signature whose fingerprint does not belong to the package is refused and the file is left as it was. Signing an already signed installer replaces its signature (the warning "Replaced existing embedded signature" is shown); a stale extended signature stream is dropped. `verify` reports no signature as `NOT_FOUND`, a signature whose fingerprint differs from the package as `INVALID` ("signature present but does not match the package contents"), a signature that cannot be read as `INVALID` ("signature present but could not be read (<detail>)"), and otherwise checks the signature with the certificate it carries.

What is not checked: whether the certificate is trusted, and the cryptographic check of the-seed's own signature container by standard verifiers. That container has no signed attributes: the ECDSA signature is made over the package fingerprint bytes, not over the DER of signed attributes, so osslsigncode reports a failure for the certificate and signature of a package signed by the-seed even when the fingerprint and structure are right. This is a known limitation; the-seed makes no claim about how Windows or standard verifiers treat its own installer signatures.

What was and was not verified: the fingerprint and the package structure written by libthe-seed were compared with osslsigncode 2.14, with an independent reader written for the tests, and (for stream lookup by name) with Wine 10's structured-storage implementation. They were not checked with Microsoft's signtool, WinVerifyTrust, the Windows Installer service or Microsoft's own storage code, because no Windows machine is part of the test setup. Certificate trust is not checked. Installers signed by earlier versions of the-seed may be damaged; re-sign them from the unsigned original when you have it. (Re-signing the signed file in place repairs the signature itself but cannot restore other damage an earlier version may have caused.)

Use `--detached` to force detached signatures even for PE and Mach-O files:

```bash
# Embedded (default for PE/Mach-O)
the-seed signing sign myapp.exe

# Detached (forced)
the-seed signing sign --detached myapp.exe

# Detached (default for non-binary files)
the-seed signing sign config.json
```

**Builds sign automatically.** `the-seed build` signs the programs and libraries it installs with the project's scope certificate; see [What is installed, stripped and signed](#what-is-installed-stripped-and-signed). `verify` works on installed files and on any of a library's link names.

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
| `configFile` | `string` | Configuration filename (`config.json`) |
| `configPath` | `string` | Full path of the configuration file (`configDir` joined with `configFile`) |
| `config` | `ConfigType` | The loaded configuration object |

**Methods**:

| Method | Return Type | Description |
|--------|-------------|-------------|
| `loadConfig()` | `void` | Load configuration from disk. Creates the directory and a default file when missing, fills missing entries in memory, and throws `ConfigError` for a malformed file |
| `saveConfig()` | `void` | Write current configuration to disk atomically (creating the directory if needed); throws `ConfigError` when it cannot |
| `getQuestions()` | `object[]` | Return inquirer prompt questions for configuration |
| `parseAnswers(answers: { prefix: string })` | `void` | Apply prompt answers to the configuration |

#### ConfigError

A named export of the `Config` module (`import Config, { ConfigError } from "@metaverse-systems/the-seed/dist/Config"`). Thrown by `loadConfig()` and `saveConfig()`; it extends `Error`.

| Property | Type | Description |
|----------|------|-------------|
| `path` | `string` | The configuration file the problem concerns |
| `message` | `string` | One line naming the file and the entry or cause |

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
| `signFileMachO(filePath: string, scope: string)` | `Promise<SignResult>` | Embed a code signature in a Mach-O binary (prepare, sign each CodeDirectory, complete; see "Mac programs" above for what is and is not verified) |
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

## Running the checks

### Prerequisites

- libthe-seed (0.8.0 or later) and libecs-cpp (2.1.0 or later) installed and reachable by `pkg-config`. If they are in a non-system prefix, such as the one `the-seed dependencies install` makes, point `PKG_CONFIG_PATH` at its `lib/pkgconfig` directory:

  ```bash
  export PKG_CONFIG_PATH="$HOME/the-seed/x86_64-linux-gnu/lib/pkgconfig:$PKG_CONFIG_PATH"
  pkg-config --modversion the-seed ecs-cpp
  ```

- `openssl` (one signing test generates a certificate with it).
- Optional: `python3`. The independent Mach-O cross-check in `test/Signing.embedded.test.ts` runs `../libthe-seed/tests/fixtures/check_pages.py` when the parent repository is present. Without it the case prints a `SKIPPED CHECK:` line and carries on, unless `THE_SEED_REQUIRE_TOOLS=1` is set, in which case a missing tool fails the case.

### Build and run

```bash
npm ci
npm run build-addon     # the tests load the native addon
npm test                # typecheck, then lint, then unit
```

`npm test` runs three stages in order and ends with a line such as `Summary: typecheck PASS, lint PASS, unit PASS`. It exits non-zero if any stage fails, and a failing stage does not stop the later ones from running. Run one stage, or a subset of the tests:

```bash
npm run typecheck                       # tsc over src/ and test/
npm run lint                            # ESLint over src/ and test/
npm test -- unit                        # Jest only (at most 4 workers)
npm test -- unit -t "verifyFileAuthenticode"
npm test -- unit test/Signing.test.ts
```

Failures are named as `FAILED: <file> › <case>` or `FAILED GROUP: <file>: <message>` (a test file that could not run, or whose hook failed), and the run ends with a `Totals:` line. Skipped cases are reported and counted.

### Known gaps

No entries remain; the list is `[]`. A case that fails today because of a problem recorded in `docs/reviews/the-seed-1.md` is listed in `test/known-gaps.json` and marked in its test file with `itKnownGap`. It is reported as `KNOWN GAP:` and does not fail the run. The task that fixes the problem must remove both the marker and the entry: a marked case that now passes is reported as `STALE KNOWN GAP:` and fails the run, and an entry that is malformed or does not match the review and the roadmap in the parent repository is reported as `MALFORMED KNOWN GAP:` and fails the run.

### Isolation

`npm test` runs Jest with `HOME`, `USERPROFILE`, `XDG_CONFIG_HOME`, `TMPDIR`, `TMP` and `TEMP` pointing into a fresh scratch directory, so the tests never read or write your real `~/the-seed`. It also sets `NODE_DISABLE_COMPILE_CACHE=1` so that Node processes started by tests do not write a module compile cache into the scratch area. The runner prints `LEFTOVER:` for any file a test leaves in the scratch area, removes the area afterwards, and prints `REAL HOME CHANGED:` if your real `~/the-seed` differs after the run. Both fail the run. Run the tests through `npm test`, not by calling `jest` directly, so that this protection applies.

### Hosted check

Every proposal to `main` and every push to `main` runs the `check` job in `.github/workflows/ci.yaml` with read-only repository permissions. It builds the tool and the addon against libecs-cpp and libthe-seed at fixed commits (libecs-cpp `16a272ce17bf03369febf0796444a8df8cd1ffec`, libthe-seed `839bc62d3233e88347059942ce25e84da23b48ee`), then runs the type check, the style check and the tests with `THE_SEED_REQUIRE_TOOLS=1`. The commits are set in the `env` block at the top of the workflow; change them there when the tool needs newer libraries. A manual run (Actions, CI, Run workflow) accepts `repeat` to run the tests several times in a row.

### Notes

- The style check disables `@typescript-eslint/no-var-requires` on five lines (`src/Package.ts`, `src/Signing.ts`, `test/Package.test.ts`, `test/Signing.embedded.test.ts`, `test/TestInfrastructure.test.ts`), each with a reason: the native addon has no type declarations, or a module must be loaded again after Jest resets its registry. No rule is disabled in the ESLint configuration.
- The build tests (`Build`, `BuildCLI`, `RecursiveBuild`) are mock-based: they check which commands would run. `test/BuildEndToEnd.test.ts` goes further and builds and installs a real autotools project into a temporary prefix, including the native and Windows strip-and-sign cases (the Windows ones need mingw-w64 and report `SKIPPED CHECK:` when it is absent); without autotools, `git`, `file` or the mingw-w64 compiler its cases report `SKIPPED CHECK:` and carry on, unless `THE_SEED_REQUIRE_TOOLS=1` is set.

## License

MIT -- See [LICENSE](LICENSE) for details.

## Author

Tim Schwartz <tim@metaverse.systems>
