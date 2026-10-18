import ConfigCLI from "./ConfigCLI";
import ScopesCLI from  "./ScopesCLI";
import TemplateCLI from "./TemplateCLI";
import BuildCLI from "./BuildCLI";
import ResourcePakCLI from "./ResourcePakCLI";
import DependenciesCLI from "./DependenciesCLI";
import PackageCLI from "./PackageCLI";
import SigningCLI from "./SigningCLI";
import InstallerCLI from "./InstallerCLI";
import { ConfigError } from "../Config";
import { ScriptArgsType } from "../types";

export async function runCli(args: string[], configDir: string, binName: string): Promise<void> {
  const scriptConfig: ScriptArgsType = { binName, args, configDir };
  const section = args[2] || "help";

  try {
    switch(section)
    {
      case "help":
        console.log(binName + " dependencies");
        console.log(binName + " build");
        console.log(binName + " config");
        console.log(binName + " scopes");
        console.log(binName + " template");
        console.log(binName + " package");
        console.log(binName + " resource-pak");
        console.log(binName + " signing");
        console.log(binName + " installer");
        break;
      case "config":
        await ConfigCLI(scriptConfig);
        break;
      case "scopes":
        await ScopesCLI(scriptConfig);
        break;
      case "template":
        await TemplateCLI(scriptConfig);
        break;
      case "build":
        await BuildCLI(scriptConfig);
        break;
      case "resource-pak":
        await ResourcePakCLI(scriptConfig);
        break;
      case "dependencies":
        await DependenciesCLI(scriptConfig);
        break;
      case "package":
        await PackageCLI(scriptConfig);
        break;
      case "signing":
        await SigningCLI(scriptConfig);
        break;
      case "installer":
        await InstallerCLI(scriptConfig);
        break;
      default:
        console.log("Invalid command. Use 'the-seed help' for usage information.");
        break;
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
