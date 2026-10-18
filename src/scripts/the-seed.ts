#!/usr/bin/env node
import os from "os";
import path from "path";
import { runCli } from "./Cli";

const binName = path.basename(process.argv[1]);
const configDir = os.homedir() + "/the-seed";

runCli(process.argv, configDir, binName);
