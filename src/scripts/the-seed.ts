#!/usr/bin/env node
import os from "os";
import path from "path";
import ConfigCLI from "./ConfigCLI";
import ScopesCLI from  "./ScopesCLI";
import TemplateCLI from "./TemplateCLI";
import { ScriptArgsType } from "../types";

const homedir = os.homedir;

const scriptConfig: ScriptArgsType = {
  binName: path.basename(process.argv[1]),
  args: process.argv,
  configDir: homedir + "/.config/the-seed"
};

const section = scriptConfig.args[2] || "help";

switch(section)
{
  case "help":
    console.log(scriptConfig.binName + " config");
    console.log(scriptConfig.binName + " scopes");
    console.log(scriptConfig.binName + " template");
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
}
