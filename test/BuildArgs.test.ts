import { parseBuildArgs, BuildArgsResult } from "../src/BuildArgs";
import { BuildRequest } from "../src/types";

function expectRequest(result: BuildArgsResult): BuildRequest {
  if (!result.ok) {
    throw new Error(`Expected the arguments to be accepted, got: ${result.message}`);
  }
  return result.request;
}

/** Every ordering of the given words. */
function permutations(words: string[]): string[][] {
  if (words.length <= 1) return [words];
  return words.flatMap((word, i) =>
    permutations([...words.slice(0, i), ...words.slice(i + 1)]).map((rest) => [word, ...rest])
  );
}

describe("parseBuildArgs", () => {
  describe("target slot", () => {
    it("gives an incremental build with no arguments", () => {
      const request = expectRequest(parseBuildArgs([]));
      expect(request.mode).toBe("incremental");
      expect(request.target).toBeUndefined();
      expect(request.recursive).toBe(false);
      expect(request.release).toBe(false);
      expect(request.parallel).toBe(1);
      expect(request.deprecatedBareWord).toBe(false);
    });

    it("gives help for 'help' and ignores later arguments", () => {
      expect(expectRequest(parseBuildArgs(["help"])).mode).toBe("help");
      expect(expectRequest(parseBuildArgs(["help", "anything"])).mode).toBe("help");
      expect(expectRequest(parseBuildArgs(["help", "--bogus"])).mode).toBe("help");
    });

    it.each(["native", "windows"])("gives a full non-recursive build for %s", (target) => {
      expect(expectRequest(parseBuildArgs([target]))).toEqual({
        mode: "full",
        target,
        recursive: false,
        release: false,
        parallel: 1,
        deprecatedBareWord: false,
      });
    });
  });

  describe("--recursive and --release", () => {
    it.each(["native", "windows"])("accepts every ordering after %s", (target) => {
      for (const words of [["--recursive"], ["--release"], ["--recursive", "--release"]]) {
        for (const order of permutations(words)) {
          expect(expectRequest(parseBuildArgs([target, ...order]))).toEqual({
            mode: "full",
            target,
            recursive: words.includes("--recursive"),
            release: words.includes("--release"),
            parallel: 1,
            deprecatedBareWord: false,
          });
        }
      }
    });

    it("accepts --recursive and --release given twice as if given once", () => {
      expect(expectRequest(parseBuildArgs(["native", "--recursive", "--recursive"]))).toEqual(
        expectRequest(parseBuildArgs(["native", "--recursive"]))
      );
      expect(expectRequest(parseBuildArgs(["native", "--release", "--release"]))).toEqual(
        expectRequest(parseBuildArgs(["native", "--release"]))
      );
    });
  });
});

function expectRejection(args: string[]): { argument: string; message: string } {
  const result = parseBuildArgs(args);
  if (result.ok) {
    throw new Error(`Expected ${JSON.stringify(args)} to be rejected`);
  }
  return { argument: result.argument, message: result.message };
}

describe("parseBuildArgs rejections", () => {
  it("rejects an unknown dashed option", () => {
    expect(expectRejection(["native", "--recursve"])).toEqual({
      argument: "--recursve",
      message: "Unrecognized option \"--recursve\".",
    });
  });

  it("rejects an unknown bare word", () => {
    expect(expectRejection(["native", "recursve"])).toEqual({
      argument: "recursve",
      message: "Unrecognized argument \"recursve\".",
    });
  });

  it("rejects an unknown word anywhere after the target", () => {
    expect(expectRejection(["windows", "--recursive", "--release", "extra"]).message).toBe(
      "Unrecognized argument \"extra\"."
    );
    expect(expectRejection(["windows", "--release", "-r"]).message).toBe(
      "Unrecognized option \"-r\"."
    );
  });

  it("rejects --parallel without a recursive build", () => {
    for (const args of [["native", "--parallel", "4"], ["native", "--parallel=4", "--release"]]) {
      expect(expectRejection(args)).toEqual({
        argument: "--parallel",
        message: "--parallel applies only to recursive builds; add --recursive.",
      });
    }
  });

  it.each([
    [["native", "--recursive", "--parallel"]],
    [["native", "--recursive", "--parallel", "--release"]],
    [["native", "--parallel", "--recursive"]],
    [["native", "--recursive", "--parallel="]],
  ])("rejects a missing --parallel value in %p", (args) => {
    expect(expectRejection(args)).toEqual({
      argument: "--parallel",
      message: "--parallel requires a positive whole number.",
    });
  });

  it.each(["0", "-2", "1.5", "x", "4x", "+3", "007x", String(Number.MAX_SAFE_INTEGER + 2), "99999999999999999999"])(
    "rejects the --parallel value %p",
    (value) => {
      expect(expectRejection(["native", "--recursive", "--parallel", value])).toEqual({
        argument: value,
        message: `Invalid value "${value}" for --parallel; expected a positive whole number.`,
      });
    }
  );

  it("rejects an invalid inline --parallel value", () => {
    expect(expectRejection(["native", "--recursive", "--parallel=0"])).toEqual({
      argument: "--parallel=0",
      message: "Invalid value \"0\" for --parallel; expected a positive whole number.",
    });
  });

  it("rejects --parallel given more than once", () => {
    for (const args of [
      ["native", "--recursive", "--parallel", "2", "--parallel", "3"],
      ["native", "--recursive", "--parallel", "2", "--parallel=3"],
      ["native", "--recursive", "--parallel=2", "--parallel=2"],
    ]) {
      expect(expectRejection(args).message).toBe("--parallel was given more than once.");
    }
  });

  it.each(["--recursive", "--release", "--parallel"])("rejects %s in the target slot", (arg) => {
    expect(expectRejection([arg])).toEqual({
      argument: arg,
      message: "A build target is required: native or windows.",
    });
  });

  it("rejects an unknown target", () => {
    expect(expectRejection(["foo"])).toEqual({
      argument: "foo",
      message: "Unrecognized build target \"foo\"; expected native or windows.",
    });
  });
});

describe("parseBuildArgs --parallel", () => {
  it.each(["native", "windows"])("accepts --parallel 4 and --parallel=4 in every position after %s", (target) => {
    for (const parallelWords of [["--parallel", "4"], ["--parallel=4"]]) {
      const parallelToken = parallelWords.join(" ");
      for (const words of [["--recursive", parallelToken], ["--recursive", parallelToken, "--release"]]) {
        for (const order of permutations(words)) {
          const args = [target, ...order.flatMap((word) => (word === parallelToken ? parallelWords : [word]))];
          expect(expectRequest(parseBuildArgs(args))).toEqual({
            mode: "full",
            target,
            recursive: true,
            release: words.includes("--release"),
            parallel: 4,
            deprecatedBareWord: false,
          });
        }
      }
    }
  });

  it("accepts large but safe values", () => {
    expect(expectRequest(parseBuildArgs(["native", "--recursive", "--parallel", "64"])).parallel).toBe(64);
    expect(
      expectRequest(parseBuildArgs(["native", "--recursive", `--parallel=${Number.MAX_SAFE_INTEGER}`])).parallel
    ).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("parseBuildArgs deprecated bare word", () => {
  it.each([
    [["native", "recursive"], ["native", "--recursive"]],
    [["native", "recursive", "--release"], ["native", "--recursive", "--release"]],
    [["windows", "--release", "recursive"], ["windows", "--release", "--recursive"]],
    [["native", "recursive", "--recursive"], ["native", "--recursive"]],
    [["native", "recursive", "recursive"], ["native", "--recursive"]],
    [["native", "recursive", "--parallel", "2"], ["native", "--recursive", "--parallel", "2"]],
  ])("treats %p like %p and flags the deprecated word", (bare, dashed) => {
    const bareRequest = expectRequest(parseBuildArgs(bare));
    const dashedRequest = expectRequest(parseBuildArgs(dashed));
    expect(bareRequest.recursive).toBe(true);
    expect(bareRequest.deprecatedBareWord).toBe(true);
    expect(dashedRequest.deprecatedBareWord).toBe(false);
    expect({ ...bareRequest, deprecatedBareWord: false }).toEqual(dashedRequest);
  });
});
