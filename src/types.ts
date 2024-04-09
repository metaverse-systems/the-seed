export interface AuthorType {
  name: string;
  email: string;
  url: string;
}

export interface ScopeType {
  author: AuthorType;
}

export interface ScopesType {
  [index: string]: ScopeType;
}

export interface ConfigType {
  [index: string]: any;
  prefix: string;
  scopes: ScopesType;
}

export interface ScriptArgsType {
  binName: string;
  args: string[];
  configDir: string;
}

export interface ResourceType {
  name: string;
  filename: string;
  size: number;
}

export interface PackageType {
  author: AuthorType;
  name: string;
  licence: string;
  scripts: {
    [index: string]: string;
  };
  resources: ResourceType[];
}