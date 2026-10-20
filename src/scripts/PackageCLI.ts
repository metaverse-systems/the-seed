import Config from "../Config";
import Package from "../Package";
import { ScriptArgsType } from "../types";

const PackageCLI = async (scriptConfig: ScriptArgsType) => {
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
    console.log("");
    console.log("Dependency projects are found the way \"the-seed build --recursive\" finds them, from the");
    console.log("\"dependencies\" of each project's package.json: a \"file:\" path is taken relative to the declaring");
    console.log("project, and any other dependency (for example one installed from npm) is looked up in that");
    console.log("project's node_modules. Linux libraries are written under the name programs load them by");
    console.log("(for example libgreet.so.0), each with its .sig when signed.");
    console.log("Two different files with the same name are refused; nothing is written.");
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
  const result = await pkg.run(outputDir, projectDirs);

  if (!result.success) {
    process.exit(1);
  }
};

export default PackageCLI;
