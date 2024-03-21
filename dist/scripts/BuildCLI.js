"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const Config_1 = tslib_1.__importDefault(require("../Config"));
const Build_1 = tslib_1.__importDefault(require("../Build"));
const BuildCLI = (scriptConfig) => {
    const config = new Config_1.default(scriptConfig.configDir);
    const command = scriptConfig.args[3];
    const build = new Build_1.default(config);
    switch (command) {
        case "help":
            console.log("Available build targets:");
            console.log("  native");
            console.log("  windows");
            console.log("  wasm");
            break;
        case "native":
        case "windows":
        case "wasm":
            build.reconfigure(command);
            build.compile();
            build.install();
            break;
        default:
            build.compile();
            build.install();
            break;
    }
};
exports.default = BuildCLI;
//# sourceMappingURL=BuildCLI.js.map