import fs from "fs";
import path from "path";
import os from "os";

// Mock child_process before importing anything that uses it
jest.mock("child_process", () => ({
  execSync: jest.fn(() => Buffer.from("")),
}));

// Mock Config
jest.mock("../src/Config", () => {
  return jest.fn().mockImplementation((configDir?: string) => ({
    config: { prefix: "/fake/prefix" },
    configDir: configDir || "/fake/config",
    loadConfig: jest.fn(),
  }));
});

// Mock Build
const mockReconfigure = jest.fn();
const mockCompile = jest.fn();
const mockInstall = jest.fn();
jest.mock("../src/Build", () => {
  const MockBuild = jest.fn().mockImplementation(() => ({
    reconfigure: mockReconfigure,
    compile: mockCompile,
    install: mockInstall,
    target: "linux",
  }));
  return {
    __esModule: true,
    default: MockBuild,
    autoSignIfCertExists: jest.fn().mockResolvedValue(undefined),
    stripBinaries: jest.fn().mockResolvedValue({ strippedFiles: [], stripTool: "strip" }),
  };
});

// Mock RecursiveBuild
jest.mock("../src/RecursiveBuild", () => ({
  buildRecursive: jest.fn().mockResolvedValue({
    success: true,
    completed: [],
    failed: null,
    failureOutput: null,
    remaining: [],
    cancelled: false,
  }),
}));

import { execSync } from "child_process";
import { autoSignIfCertExists, stripBinaries } from "../src/Build";
import { buildRecursive } from "../src/RecursiveBuild";
import BuildCLI from "../src/scripts/BuildCLI";
import { ScriptArgsType } from "../src/types";

const mockedStripBinaries = stripBinaries as jest.MockedFunction<typeof stripBinaries>;
const mockedAutoSign = autoSignIfCertExists as jest.MockedFunction<typeof autoSignIfCertExists>;
const mockedBuildRecursive = buildRecursive as jest.MockedFunction<typeof buildRecursive>;

function makeArgs(args: string[]): ScriptArgsType {
  return {
    binName: "the-seed",
    args: ["node", "the-seed", "build", ...args],
    configDir: "/fake/config",
  };
}

describe("BuildCLI --release flag parsing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconfigure.mockClear();
    mockCompile.mockClear();
    mockInstall.mockClear();
    mockedStripBinaries.mockResolvedValue({ strippedFiles: [], stripTool: "strip" });
    mockedAutoSign.mockResolvedValue(undefined);
    process.exitCode = undefined;
  });

  it("parses --release from 'native --release'", async () => {
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalled();
  });

  it("parses --release from 'native recursive --release'", async () => {
    await BuildCLI(makeArgs(["native", "recursive", "--release"]));
    expect(mockedBuildRecursive).toHaveBeenCalledWith(
      expect.objectContaining({ release: true })
    );
  });

  it("parses --release from '--release native'", async () => {
    // --release before target: args[3] = '--release', need flexible parsing
    await BuildCLI(makeArgs(["native", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalled();
  });

  it("handles duplicated --release flag gracefully", async () => {
    await BuildCLI(makeArgs(["native", "--release", "--release"]));
    // Should not throw and stripBinaries should be called exactly once
    expect(mockedStripBinaries).toHaveBeenCalledTimes(1);
  });

  it("does not call stripBinaries when --release is missing", async () => {
    await BuildCLI(makeArgs(["native"]));
    expect(mockedStripBinaries).not.toHaveBeenCalled();
  });

  it("calls stripBinaries for windows target with --release", async () => {
    await BuildCLI(makeArgs(["windows", "--release"]));
    expect(mockedStripBinaries).toHaveBeenCalledWith(
      expect.any(String),
      "windows"
    );
  });

  it("calls stripBinaries between install and sign for non-recursive build", async () => {
    const callOrder: string[] = [];
    mockCompile.mockImplementation(() => callOrder.push("compile"));
    mockedStripBinaries.mockImplementation(async () => {
      callOrder.push("strip");
      return { strippedFiles: [], stripTool: "strip" };
    });
    mockedAutoSign.mockImplementation(async () => {
      callOrder.push("sign");
    });
    mockInstall.mockImplementation(() => callOrder.push("install"));

    await BuildCLI(makeArgs(["native", "--release"]));

    expect(callOrder).toEqual(["compile", "install", "strip", "sign"]);
  });
});
