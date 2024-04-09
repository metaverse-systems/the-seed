"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tslib_1 = require("tslib");
const fs = require("fs-extra");
const { execSync } = require("child_process");
const Scopes_1 = tslib_1.__importDefault(require("./Scopes"));
class ResourcePak {
    constructor(config, dir) {
        this.create = (name) => {
            if (!this.package) {
                execSync("npm init --yes", { cwd: this.packageDir });
            }
            this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
            if (this.package) {
                this.package.name = name;
                if (!this.package.scripts) {
                    this.package.scripts = {
                        build: "the-seed resource-pak build",
                    };
                }
                if (!this.package.resources) {
                    this.package.resources = [];
                }
            }
        };
        this.savePackage = () => {
            fs.writeFileSync(this.packageDir + "/package.json", JSON.stringify(this.package, null, 2));
        };
        this.addResource = (name, filename) => {
            if (!this.package) {
                return;
            }
            if (this.package.resources) {
                if (this.package.resources.find((r) => r.name === name)) {
                    return;
                }
            }
            else {
                this.package.resources = [];
            }
            const stats = fs.statSync(filename);
            this.package.resources.push({
                name: name,
                filename: filename,
                size: stats.size,
            });
        };
        this.build = () => {
            if (!this.package) {
                return;
            }
            this.savePackage();
            const header = {
                name: this.package.name,
                headerSize: JSON.stringify(this.package.resources)
                    .length.toString()
                    .padStart(10, "0"),
                resources: this.package.resources,
            };
            header.headerSize = JSON.stringify(header).length.toString().padStart(10, "0");
            const [, name] = this.package.name.split("/");
            fs.writeFileSync(this.packageDir + "/" + name + ".pak", JSON.stringify(header));
            this.package.resources.forEach((r) => {
                fs.appendFileSync(name + ".pak", fs.readFileSync(r.filename));
            });
        };
        this.config = config;
        this.scopes = new Scopes_1.default(config);
        this.packageDir = dir;
        if (fs.existsSync(this.packageDir + "/package.json")) {
            this.package = JSON.parse(fs.readFileSync(this.packageDir + "/package.json"));
        }
    }
}
exports.default = ResourcePak;
//# sourceMappingURL=ResourcePak.js.map