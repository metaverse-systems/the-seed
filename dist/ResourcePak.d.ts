import Config from "./Config";
import Scopes from "./Scopes";
import { PackageType } from "./types";
declare class ResourcePak {
    packageDir: string;
    config: Config;
    scopes: Scopes;
    package?: PackageType;
    constructor(config: Config, dir: string);
    create: (name: string) => void;
    savePackage: () => void;
    addResource: (name: string, filename: string) => void;
    build: () => void;
}
export default ResourcePak;
