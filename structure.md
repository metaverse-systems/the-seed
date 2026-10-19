# Directory structure

## Configuration file

```
    ~/the-seed/config.json
```

## The Seed development environment

* Defaults to ~/the-seed

```
    |-- ~/the-seed
        |-- include
        |-- x86_64-linux-gnu
            |-- bin
            |-- lib
        |-- x86_64-w64-mingw32
            |-- bin
            |-- lib
```

## Native addon (`native/src/addon.cpp`)

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
* `test/helpers/Universal.ts` assembles universal Mac programs from given slices (a 32-bit big-endian table, slices at `2^align` boundaries) for tests that need a partly signed or unsupported-slice program. `test/helpers/Command.ts` runs `signing verify` through `runCli` with a scratch configuration directory and a scratch `HOME`, capturing its output and exit status. Neither shares code with `src/`.
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
