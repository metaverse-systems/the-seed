import Config from "../Config";
import Package from "../Package";
import { ScriptArgsType } from "../types";

const PackageCLI = (scriptConfig: ScriptArgsType) => {
  const command = scriptConfig.args[3];

  // No arguments or help subcommand
  if (!command || command === "help") {
    console.log("Usage: the-seed package <directory> <file1> [file2] ...");
    console.log("");
    console.log("Package binary files with their shared library dependencies into a directory.");
    console.log("");
    console.log("Arguments:");
    console.log("  directory    Name of the output directory to create");
    console.log("  file1...     Binary files (executables or libraries) to include");
    console.log("");
    console.log("The command uses DependencyLister from libthe-seed to resolve all shared");
    console.log("library dependencies and copies them into the output directory.");
    return;
  }

  const outputDir = command;
  const binaryPaths = scriptConfig.args.slice(4);

  // No files specified
  if (binaryPaths.length === 0) {
    console.error("Usage: the-seed package <directory> <file1> [file2] ...");
    process.exit(1);
  }

  const config = new Config(scriptConfig.configDir);
  const pkg = new Package(config);
  const success = pkg.run(outputDir, binaryPaths);

  if (!success) {
    process.exit(1);
  }
};

export default PackageCLI;
