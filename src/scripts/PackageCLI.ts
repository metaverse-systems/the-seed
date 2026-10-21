import fs from "fs";
import Config from "../Config";
import Package from "../Package";
import { requireNativeComponent } from "../NativeComponent";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { HandlerResult, MissingError } from "../cli/ExitStatus";

const PackageCLI = async (parsed: ParsedCommand, context: CliContext): Promise<HandlerResult> => {
  const outputDir = parsed.positionals["output-directory"] as string;
  const projectDirs = parsed.positionals["project-dir"] as string[];

  // Packaging needs the native component; its absence is reported before anything is read or written
  requireNativeComponent();

  // A project directory that does not exist is missing input (an existing output directory is refused by the packaging itself)
  if (!fs.existsSync(outputDir)) {
    for (const projectDir of projectDirs) {
      if (!fs.existsSync(projectDir)) {
        throw new MissingError("Directory not found: " + projectDir);
      }
    }
  }

  const config = new Config(context.configDir);
  const pkg = new Package(config);
  const result = await pkg.run(outputDir, projectDirs);

  if (!result.success) {
    return { status: 1 };
  }
};

export default PackageCLI;
