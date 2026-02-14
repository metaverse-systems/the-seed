#!/usr/bin/env node
import os from "os";
import path from "path";
import ConfigCLI from "./ConfigCLI";
import ScopesCLI from  "./ScopesCLI";
import TemplateCLI from "./TemplateCLI";
import BuildCLI from "./BuildCLI";
import ResourcePakCLI from "./ResourcePakCLI";
import DependenciesCLI from "./DependenciesCLI";
import PackageCLI from "./PackageCLI";
import { ScriptArgsType } from "../types";

const homedir = os.homedir;

const scriptConfig: ScriptArgsType = {
  binName: path.basename(process.argv[1]),
  args: process.argv,
  configDir: homedir + "/the-seed"
};

const section = scriptConfig.args[2] || "help";

switch(section)
{
  case "help":
    console.log(scriptConfig.binName + " dependencies");
    console.log(scriptConfig.binName + " build");
    console.log(scriptConfig.binName + " config");
    console.log(scriptConfig.binName + " scopes");
    console.log(scriptConfig.binName + " template");
    console.log(scriptConfig.binName + " package");
    console.log(scriptConfig.binName + " resource-pak");
    break;
  case "config":
    ConfigCLI(scriptConfig);
    break;
  case "scopes":
    ScopesCLI(scriptConfig);
    break;
  case "template":
    TemplateCLI(scriptConfig);
    break;
  case "build":
    BuildCLI(scriptConfig);
    break;
  case "resource-pak":
    ResourcePakCLI(scriptConfig);
    break;
  case "dependencies":
    DependenciesCLI(scriptConfig);
    break;
  case "package":
    PackageCLI(scriptConfig);
    break;
  default:
    console.log("Invalid command. Use 'the-seed help' for usage information.");
    break;
}
