"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const Config_1 = tslib_1.__importDefault(require("../Config"));
const ResourcePak_1 = tslib_1.__importDefault(require("../ResourcePak"));
const ResourcePakCLI = (scriptConfig) => {
    const config = new Config_1.default(scriptConfig.configDir);
    const command = scriptConfig.args[3];
    const name = scriptConfig.args[4];
    let rp;
    switch (command) {
        case "help":
            console.log("Available resource-pak commands:");
            console.log("  create <name>");
            console.log("  add <resource-name> <filename>");
            console.log("  build");
            break;
        case "create":
            rp = new ResourcePak_1.default(config, process.cwd());
            rp.create(name);
            rp.savePackage();
            console.log(rp.package);
            break;
        case "add":
            rp = new ResourcePak_1.default(config, process.cwd());
            rp.addResource(name, scriptConfig.args[5]);
            rp.savePackage();
            console.log(rp.package);
            break;
        case "build":
            rp = new ResourcePak_1.default(config, process.cwd());
            rp.build();
            break;
    }
};
exports.default = ResourcePakCLI;
//# sourceMappingURL=ResourcePakCLI.js.map