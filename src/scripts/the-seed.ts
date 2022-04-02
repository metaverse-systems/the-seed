#!/usr/bin/env node
import os from "os";
import path from "path";
import ConfigCLI from "./ConfigCLI";
import { ScriptConfigType } from "../types";

const homedir = os.homedir;

const scriptConfig: ScriptConfigType = {
  binName: path.basename(process.argv[1]),
  args: process.argv,
  configDir: homedir + "/.config/the-seed"
};

const section = scriptConfig.args[2] || "help";

switch(section)
{
  case "help":
    console.log(scriptConfig.binName + " config");
    break;
  case "config":
    ConfigCLI(scriptConfig);
    break;
}
