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
| `machoComputeCodeDirectory`, `machoEmbedSignature` | Removed in libthe-seed 0.6.0; always throw an error that names the replacement |

Windows installer exports:

| Export | Purpose |
|---|---|
| `msiIsMsi`, `msiComputeDigest`, `msiExtractSignature`, `msiHasEmbeddedSignature` | Detect, fingerprint and read |
| `msiEmbedSignature(filePath, pkcs7Der, requireMatchingDigest?)` | Write the signature; with the flag set (default false) a blob whose fingerprint differs from the package's is refused and the file is unchanged. A non-boolean flag is a `TypeError` |
| `msiCheckSignature(filePath)` | Read back: `{ state: "none" \| "matches" \| "mismatch" \| "unreadable", storedDigest, computedDigest, detail }` |
| `msiStripSignature(filePath)` | Remove the signature; true when something was removed |

## Test helpers and fixtures

* `test/helpers/CfbChecker.ts` is an independent TypeScript walker of the installer container (Node `crypto` SHA-256, children sorted by raw name bytes, signature streams excluded). It shares no code with `src/` and reads the values recorded in `test/fixtures/binaries/genuine/msi-reference.txt`.
* `test/fixtures/binaries/genuine/` holds the installer samples (`tiny.msi`, `tiny-v4.msi`, `tiny-osslsig-*.msi`, `nested.msi`, `legacy-the-seed-0.6.0.msi`) with their SHA-256 values in its `README.md`.
