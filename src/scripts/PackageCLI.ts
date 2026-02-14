import Config from "../Config";
import Package from "../Package";
import { ScriptArgsType } from "../types";

const PackageCLI = (scriptConfig: ScriptArgsType) => {
  const command = scriptConfig.args[3];

  // No arguments or help subcommand
  if (!command || command === "help") {
    console.log("Usage: the-seed package <output-directory> <project-dir> [project-dir2] ...");
    console.log("");
    console.log("Package binaries with their shared library dependencies into a directory.");
    console.log("");
    console.log("Arguments:");
    console.log("  output-directory  Name of the output directory to create");
    console.log("  project-dir       Project directories containing src/Makefile.am");
    console.log("");
    console.log("The command reads src/Makefile.am to determine the binary type and name,");
    console.log("resolves installed binaries for all build targets, uses DependencyLister");
    console.log("to find shared library dependencies, and copies everything into the output directory.");
    return;
  }

  const outputDir = command;
  const projectDirs = scriptConfig.args.slice(4);

  // No project directories specified
  if (projectDirs.length === 0) {
    console.error("Usage: the-seed package <output-directory> <project-dir> [project-dir2] ...");
    process.exit(1);
  }

  const config = new Config(scriptConfig.configDir);
  const pkg = new Package(config);
  const success = pkg.run(outputDir, projectDirs);

  if (!success) {
    process.exit(1);
  }
};

export default PackageCLI;
