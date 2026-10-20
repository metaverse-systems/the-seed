import Config from "../Config";
import Package from "../Package";
import { CliContext, ParsedCommand } from "../cli/CommandSpec";
import { HandlerResult } from "../cli/ExitStatus";

const PackageCLI = async (parsed: ParsedCommand, context: CliContext): Promise<HandlerResult> => {
  const outputDir = parsed.positionals["output-directory"] as string;
  const projectDirs = parsed.positionals["project-dir"] as string[];

  const config = new Config(context.configDir);
  const pkg = new Package(config);
  const result = await pkg.run(outputDir, projectDirs);

  if (!result.success) {
    return { status: 1 };
  }
};

export default PackageCLI;
