import Config from "./Config";
import Scopes from "./Scopes";
import { PackageType } from "./types";
declare class ResourcePak {
    packageDir: string;
    config: Config;
    scopes: Scopes;
    package?: PackageType;
    constructor(config: Config);
    askName: () => ({
        type: string;
        name: string;
        message: string;
        choices: string[];
    } | {
        name: string;
        message: string;
        type?: undefined;
        choices?: undefined;
    })[];
    createPackage: (scope: string, name: string) => void;
    save: () => void;
    addResource: (name: string, filename: string) => void;
    build: () => void;
}
export default ResourcePak;
