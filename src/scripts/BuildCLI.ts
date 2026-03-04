import Config from "../Config";
import Build, { autoSignIfCertExists, stripBinaries } from "../Build";
import { ScriptArgsType } from "../types";
import { buildRecursive } from "../RecursiveBuild";

const BuildCLI = async (scriptConfig: ScriptArgsType) => {
  const config = new Config(scriptConfig.configDir);

  const command = scriptConfig.args[3];
  const remainingArgs = scriptConfig.args.slice(4);

  const release = remainingArgs.includes("--release");
  const modifier = remainingArgs.find(arg => arg !== "--release");

  const build = new Build(config);

  switch(command)
  {
    case "help":
      console.log("\nUsage: the-seed build <target> [recursive] [--release]");
      console.log("\nAvailable build targets:");
      console.log("  native   - Builds for the current Linux environment");
      console.log("  windows  - Cross-compiles for Windows using MinGW");
      console.log("\nOptions:");
      console.log("  recursive  - Build all transitive dependencies first, then the current project");
      console.log("  --release  - Strip debug symbols from binaries before signing (production build)");
      console.log("\nCommands:");
      console.log("  the-seed build help                          - Show this help message");
      console.log("  the-seed build native                        - Build for Linux");
      console.log("  the-seed build native --release              - Build for Linux (stripped)");
      console.log("  the-seed build native recursive              - Build all deps + project for Linux");
      console.log("  the-seed build native recursive --release    - Build all deps + project for Linux (stripped)");
      console.log("  the-seed build windows                       - Build for Windows (MinGW)");
      console.log("  the-seed build windows --release             - Build for Windows (stripped)");
      console.log("  the-seed build windows recursive             - Build all deps + project for Windows");
      console.log("  the-seed build windows recursive --release   - Build all deps + project for Windows (stripped)");
      break;
    case "native":
    case "windows":
      if (modifier === "recursive") {
        const result = await buildRecursive({
          target: command,
          fullReconfigure: true,
          projectDir: process.cwd(),
          release,
        });
        if (!result.success && !result.cancelled) {
          process.exitCode = 1;
        }
      } else {
        build.reconfigure(command);
        build.compile();
        if (release) {
          await stripBinaries(process.cwd(), command);
        }
        await autoSignIfCertExists(scriptConfig.configDir);
        build.install();
      }
      break;
    default:
      build.compile();
      await autoSignIfCertExists(scriptConfig.configDir);
      build.install();
      break;
  }
};

export default BuildCLI;
