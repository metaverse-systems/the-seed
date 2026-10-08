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
