import Config from "../Config";
import Installer from "../Installer";
import { ScriptArgsType } from "../types";

const InstallerCLI = (scriptConfig: ScriptArgsType) => {
  const command = scriptConfig.args[3];

  // No arguments or help subcommand
  if (!command || command === "help") {
    console.log("Usage: the-seed installer <target>");
    console.log("");
    console.log("Available targets:");
    console.log("  help      - Show this help message");
    console.log("  windows   - Generate a Windows MSI installer from dist/ files");
    return;
  }

  switch (command) {
    case "windows": {
      const config = new Config(scriptConfig.configDir);
      const installer = new Installer(config);
      const success = installer.run(process.cwd());
      if (!success) {
        process.exit(1);
      }
      break;
    }
    default:
      console.log("Usage: the-seed installer <target>");
      console.log("");
      console.log("Available targets:");
      console.log("  help      - Show this help message");
      console.log("  windows   - Generate a Windows MSI installer from dist/ files");
      break;
  }
};

export default InstallerCLI;
