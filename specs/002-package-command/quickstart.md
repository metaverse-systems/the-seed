# Quickstart: Package Command

**Feature**: 002-package-command

## Overview

The `package` command bundles binary files with all their shared library dependencies into a single distributable directory.

## Prerequisites

1. `the-seed` CLI installed (`npm install -g @metaverse-systems/the-seed` — this compiles the native addon against your installed `libthe-seed`)
2. `libthe-seed` installed (`the-seed dependencies install`)
3. A built project with binaries ready to package

## Usage

### Basic Packaging

```bash
# Build your project first
the-seed build native

# Package an executable with all its shared library dependencies
the-seed package my-release ./src/.libs/myapp
```

Output:
```
Copying myapp...
Copying libfoo.so...
Copying libbar.so...
Packaged 3 files into my-release/
```

### Multiple Binaries

```bash
# Package multiple executables and libraries together
the-seed package game-release ./src/.libs/game-server ./src/.libs/libgame-engine.so ./src/.libs/game-client
```

### View Help

```bash
the-seed package help
```

## How It Works

1. **Validates inputs**: Checks all specified files exist and the output directory doesn't already exist.
2. **Resolves dependencies**: Calls the `DependencyLister` C++ class from `libthe-seed` directly via a native Node.js addon, passing the specified binaries and the project's library search paths (derived from `the-seed config`).
3. **Builds file list**: Combines the explicitly listed files with all resolved shared library dependencies, deduplicating.
4. **Creates output directory**: Makes the directory specified as the first argument.
5. **Copies files**: Copies all files into the output directory, printing each one.
6. **Reports summary**: Prints the total count of files packaged.

## Common Workflows

### Build and Package for Distribution

```bash
# Configure and build
the-seed build native

# Package everything needed for the release
the-seed package release-v1.0 ./src/.libs/myapp

# The release-v1.0/ directory now contains myapp and all required .so files
ls release-v1.0/
# myapp  libecs-cpp.so  libthe-seed.so  libother-dep.so
```

### Cross-Compiled Windows Package

```bash
# Cross-compile for Windows
the-seed build windows

# Package the Windows binaries
the-seed package win-release ./src/.libs/myapp.exe

# The win-release/ directory contains the .exe and all required .dll files
ls win-release/
# myapp.exe  libecs-cpp.dll  libthe-seed.dll
```

## Error Scenarios

```bash
# File doesn't exist
the-seed package my-release ./nonexistent
# Error: File not found: ./nonexistent

# Output directory already exists
the-seed package my-release ./src/.libs/myapp  # (after running once)
# Error: Output directory already exists: my-release

# No files specified
the-seed package my-release
# Usage: the-seed package <directory> <file1> [file2] ...
```

## Programmatic Usage

The `Package` class is also available as a library import:

```typescript
import { Config, Package } from "@metaverse-systems/the-seed";

const config = new Config();
const pkg = new Package(config);
const success = pkg.run("my-release", ["./src/.libs/myapp"]);
```
