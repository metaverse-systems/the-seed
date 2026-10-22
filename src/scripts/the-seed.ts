#!/usr/bin/env node
import { runCli } from "./Cli";
import { defaultConfigDir } from "../Config";

const configDir = defaultConfigDir();

runCli(process.argv.slice(2), configDir);
