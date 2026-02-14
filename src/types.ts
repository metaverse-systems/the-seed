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
  attributes?: { [key: string]: string };
}

export interface PackageType {
  author: AuthorType;
  name: string;
  license: string;
  version: string;
  scripts: {
    [index: string]: string;
  };
  resources: ResourceType[];
  main?: string;
}

export interface ScopeAnswersType {
  scopeName: string;
  authorName: string;
  authorEmail: string;
  authorURL: string;
}

export interface ScopeDefaultsType {
  name?: string;
  email?: string;
  url?: string;
}