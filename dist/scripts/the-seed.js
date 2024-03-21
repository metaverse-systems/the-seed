#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const os_1 = tslib_1.__importDefault(require("os"));
const path_1 = tslib_1.__importDefault(require("path"));
const ConfigCLI_1 = tslib_1.__importDefault(require("./ConfigCLI"));
const ScopesCLI_1 = tslib_1.__importDefault(require("./ScopesCLI"));
const TemplateCLI_1 = tslib_1.__importDefault(require("./TemplateCLI"));
const BuildCLI_1 = tslib_1.__importDefault(require("./BuildCLI"));
const homedir = os_1.default.homedir;
const scriptConfig = {
    binName: path_1.default.basename(process.argv[1]),
    args: process.argv,
    configDir: homedir + "/the-seed"
};
const section = scriptConfig.args[2] || "help";
switch (section) {
    case "help":
        console.log(scriptConfig.binName + " build");
        console.log(scriptConfig.binName + " config");
        console.log(scriptConfig.binName + " scopes");
        console.log(scriptConfig.binName + " template");
        break;
    case "config":
        (0, ConfigCLI_1.default)(scriptConfig);
        break;
    case "scopes":
        (0, ScopesCLI_1.default)(scriptConfig);
        break;
    case "template":
        (0, TemplateCLI_1.default)(scriptConfig);
        break;
    case "build":
        (0, BuildCLI_1.default)(scriptConfig);
}
//# sourceMappingURL=the-seed.js.map