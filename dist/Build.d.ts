import Config from "./Config";
declare class Build {
    config: Config;
    target: string;
    constructor(config: Config);
    autogen: () => void;
    configure: () => void;
    reconfigure: (target: string) => void;
    compile: () => void;
    install: () => void;
}
export default Build;
