# Directory structure

The README describes the tool for its users, including the configuration file and the layout of the installation prefix. This file is the maintainers' map of the source and the tests.

## Command line

* `src/cli/Commands.ts` is the one registry of commands, subcommands, options, arguments and their help texts; `src/cli/CommandSpec.ts` holds its types. `src/cli/ParseArgs.ts` parses a command line against it, and `src/cli/Help.ts` renders every help screen from it, so the parser and the help cannot disagree.
* `src/cli/ExitStatus.ts` holds the exit-status table (`EXIT_STATUSES`), the error classes that carry a status (usage, missing, failure) and the conversion of library errors (`SigningError` and the others) into them. `src/cli/Hints.ts` holds the texts that name the next command to run, and `src/cli/ScopeChoice.ts` chooses the scope for the commands that need one.
* `src/scripts/Cli.ts` (`runCli`) is the one place that parses, runs a handler and sets the exit status; the handlers in `src/scripts/` receive an already validated command and never read `argv` or exit the process.
* `src/InstallerMetadata.ts` holds the pure functions that check and escape what goes into an installer description: names, versions and identifiers.
* `test/Readme.test.ts` keeps `README.md` in agreement with the registry, the exit-status table and the exported types and classes, and checks the repository paths named in the README and in this file. `test/Hints.test.ts` finds every `the-seed` command line in the source and parses it. `test/helpers/HintScan.ts` is the scanner and command-line checker both use; `test/helpers/RunCli.ts` runs the command line in-process with a scratch home; `test/helpers/WxsReader.ts` reads an installer description back for the metadata cases.

## Projects, templates and resource paks

* `templates/component`, `templates/system` and `templates/program` are the trees `Template.createPackage` copies. Each holds one `README.md`, the build files and the source; `gitignore` is written as `.gitignore` (npm never packs a `.gitignore`), and `{{name}}`-style variables in file names and contents are replaced by `src/TemplateEngine.ts`. No template file is empty, and `package.json` is written by the tool, not copied.
* `src/TemplateEngine.ts` renders a template tree: it substitutes the `{{…}}` variables once per file and file name (an unknown variable is an error), escapes each value for the format of the file, removes a line that is only an empty variable, and writes the project into a hidden directory that is renamed into place.
* `src/RequiredVersions.ts` holds the minimum versions of libecs-cpp and libthe-seed that generated projects ask for and `the-seed dependencies` checks.
* `src/ProjectName.ts` checks a project name (the name form, and for code projects the C++ and Automake identifier rules) and derives the identifier.
* `src/ProjectError.ts` is the error of project creation and the resource pak commands: a code, a message and a hint; `src/cli/ExitStatus.ts` maps each code to a status.
* `src/Template.ts` and `src/ResourcePak.ts` create projects in a given directory (the current one for the commands) and never write under the prefix.
* `test/Template.test.ts`, `test/TemplateEngine.test.ts`, `test/ProjectName.test.ts` and `test/RequiredVersions.test.ts` check those modules; `test/TemplateBuild.test.ts` builds each generated kind end to end against the installed libraries; `test/ResourcePak.test.ts`, `test/ResourcePakCLI.test.ts` and `test/ResourcePakRoundTrip.test.ts` check the pak commands and read the built paks back with libthe-seed's reader.
* `test/helpers/PakReader.ts` reads a pak back with the native component's `readResourcePak` and parses its description line; `test/fixtures/paks/` holds a pak built by an earlier version and the project it was built from (see its `README.md`).

## Native addon (`native/src/addon.cpp`)

Resource pak reading export:

| Export | Purpose |
|---|---|
| `readResourcePak(path)` | Open a pak with libthe-seed's own reader and return `{ names, resources }`: the resource names in order and the bytes of each resource |

Mach-O code signing exports:

| Export | Purpose |
|---|---|
| `machoPrepareSignature(filePath, identity, cmsCapacity)` | Build the finished layout in memory and return the CodeDirectory and its hash per slice; the file is not written |
| `machoCompleteSignature(filePath, prepared, cmsSignatures)` | Write the signature, one CMS buffer per slice, and replace the file once |
| `machoStripSignature(filePath)` | Remove the code signature of every slice |
| `machoBuildSuperBlob` | Format a SuperBlob only (not a signing step) |
| `machoExtractSignature`, `machoHasEmbeddedSignature` | Read; `machoHasEmbeddedSignature` is true for a universal file only when every slice is signed |
| `machoListSlices(filePath)` | The slice table, one entry per slice (one for a thin file): `cpuType`, `cpuSubtype`, `offset`, `size`, `isSigned`, `signatureOffset` (relative to the slice), `signatureSize`, `supported` and `unsupportedReason`; `verify` uses it, and throws the library's text for a file that is not a readable Mach-O program |
| `machoComputeCodeDirectory`, `machoEmbedSignature` | Removed in libthe-seed 0.6.0; always throw an error that names the replacement |

Windows installer exports:

| Export | Purpose |
|---|---|
| `msiIsMsi`, `msiComputeDigest`, `msiExtractSignature`, `msiHasEmbeddedSignature` | Detect, fingerprint and read |
| `msiEmbedSignature(filePath, pkcs7Der, requireMatchingDigest?)` | Write the signature; with the flag set (default false) a blob whose fingerprint differs from the package's is refused and the file is unchanged. A non-boolean flag is a `TypeError` |
| `msiCheckSignature(filePath)` | Read back: `{ state: "none" \| "matches" \| "mismatch" \| "unreadable", storedDigest, computedDigest, detail }` |
| `msiStripSignature(filePath)` | Remove the signature; true when something was removed |

## Signature containers

* `src/CmsBuilder.ts` builds the standard signature container (CMS SignedData with signed attributes) for Windows programs, installers and Mac programs from a certificate and a signing function; it reads nothing from files.
* `src/CmsReader.ts` reads a container (standard or earlier form) and checks the signer's signature; `src/MachOVerifier.ts` applies it to each slice of a Mac program.

## Test helpers and fixtures

* `test/helpers/CfbChecker.ts` is an independent TypeScript walker of the installer container (Node `crypto` SHA-256, children sorted by raw name bytes, signature streams excluded). It shares no code with `src/` and reads the values recorded in `test/fixtures/binaries/genuine/msi-reference.txt`.
* `test/helpers/Universal.ts` assembles universal Mac programs from given slices (a 32-bit big-endian table, slices at `2^align` boundaries) for tests that need a partly signed or unsupported-slice program. It shares no code with `src/`.
* `test/fixtures/binaries/genuine/` holds the installer samples (`tiny.msi`, `tiny-v4.msi`, `tiny-osslsig-*.msi`, `nested.msi`, `legacy-the-seed-0.6.0.msi`) with their SHA-256 values in its `README.md`.
* `test/helpers/IndependentCheck.ts` runs osslsigncode and openssl on signed files with an explicit child environment and writes edge-case certificates with openssl; it shares no code with `src/` and each check is skipped (and reported) when its tool is missing.
* `test/CmsBuilder.test.ts` checks the container builder on buffers only; `test/SignatureInterop.test.ts` signs files with the tool and checks them with osslsigncode and openssl, including edge-case and fresh certificates and re-signing.
* `test/fixtures/binaries/earlier-form/` holds a program, an installer and a universal Mac program signed in the earlier form, with the certificate that signed them and a `README.md` of how they were made and their SHA-256 values; the private key is not kept.

## Dependency discovery and packaging

* `src/DependencyWalker.ts` finds the projects a project depends on, for the recursive build and for packaging alike: `file:` paths relative to the declaring project, other names in its own `node_modules`, each project once by its real location. It reports a dependency cycle, two different directories with one package name and an unreadable `package.json` as errors before anything is built or copied.
* `src/ElfNames.ts` reads the soname and the needed library names from an ELF file; packaging writes each Linux library under its soname and lists the needed libraries it did not package.
* `test/ElfNames.test.ts` checks the reader against images written by `test/helpers/ElfImage.ts`, which builds minimal ELF files (including malformed ones) in memory.
* `test/PackageLayout.test.ts` packages scratch trees with the real addon and checks the written names, signatures, collisions, the not-packaged list and the files counted. `test/helpers/NativeTree.ts` compiles the libraries and programs those trees hold directly with `cc` (or the MinGW compiler) and runs a packaged program with a fixed environment.
* `test/RecursiveDiscovery.test.ts` runs the real walker, the recursive build and the build command against scratch trees with every build step mocked: cycles, links, conflicts and stop requests during scanning. `test/helpers/ScratchProjects.ts` writes those trees and holds the read bound that makes a looping walk fail after 200 reads.

## Native component and installation

* `native/build.js` builds the native component (`npm run build-addon`, and the package's `install` script with `--install`): it reads the configured prefix, checks the prerequisites, runs node-gyp and prints a report; a failed build does not fail an installation.
* `native/pkg-config.js` holds what `native/build.js` and the install check share: finding the prefix the way the tool does, the pkg-config search setting (prefix first, then the caller's `PKG_CONFIG_PATH`) and the libthe-seed version `native/binding.gyp` requires.
* `src/NativeComponent.ts` is the one place the native component is loaded: `loadNativeComponent`, `requireNativeComponent`, `NativeComponentMissingError` and the message that names the step.
* `test/helpers/NativeAbsent.ts` makes the component absent, or present but not loading, inside one test, without touching the built files.
* `test/NativeComponent.test.ts`, `test/NativeBuild.test.ts` and `test/PackageContents.test.ts` check the loader and its message, the build script (with injected probes and runner, never a real node-gyp build) and the files the published package contains.
* `test/InstallPhase.test.ts` checks the install phase when signing is not possible.
* The `install` stage of `scripts/run-checks.js` (`npm test -- install`) packs the package, installs the tarball into scratch locations and checks signing with and without libthe-seed, and an install from git; it is not part of a plain `npm test`.
