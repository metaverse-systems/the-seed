#!/usr/bin/env node
import os from "os";
import { runCli } from "./Cli";

const configDir = os.homedir() + "/the-seed";

runCli(process.argv.slice(2), configDir);
