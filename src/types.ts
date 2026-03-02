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
  name?: string;
  email?: string;
  org?: string;
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

export interface DependencyResultType {
  dependencies: Record<string, string[]>;
  errors: Record<string, string>;
}

export interface BuildStep {
  /** Human-readable step name (e.g., 'autogen', 'configure', 'compile', 'install') */
  label: string;
  /** Shell command to execute */
  command: string;
  /** If true, non-zero exit codes do not abort the build (used for 'make distclean') */
  ignoreExitCode?: boolean;
}

// ── Code Signing Types ──────────────────────────────────────

export interface CertSubject {
  commonName: string;
  email?: string;
  organization?: string;
}

export interface CertOptions {
  validityDays?: number; // default: 365
}

export interface CertInfo {
  subject: CertSubject;
  issuer: string;       // "self-signed" or CA distinguished name
  fingerprint: string;  // "SHA256:<hex>"
  keyType: string;      // "ECDSA P-256"
  notBefore: Date;
  notAfter: Date;
  isExpired: boolean;
  certPath: string;     // absolute path to cert.pem
}

export interface SignResult {
  filePath: string;       // path to the original file
  signaturePath: string;  // path to the .sig file
  fingerprint: string;    // certificate fingerprint
}

export interface DirectorySignResult {
  manifestPath: string;   // path to .signatures.json
  signed: SignResult[];   // list of signed files
  skipped: string[];      // list of skipped (non-binary) files
}

export type VerifyStatus = 'VALID' | 'INVALID' | 'NOT_FOUND';

export interface VerifyResult {
  filePath: string;
  status: VerifyStatus;
  reason?: string;        // human-readable reason for INVALID/NOT_FOUND
  signer?: CertInfo;      // certificate info of the signer (if signature exists)
}

export interface DirectoryVerifyResult {
  results: VerifyResult[];
  passed: number;
  failed: number;
  notFound: number;
  overallPass: boolean;
}

/** Structure of a .sig file (JSON) */
export interface SigFileFormat {
  version: 1;
  algorithm: 'SHA256';
  curve: 'P-256';
  signature: string;       // base64-encoded ECDSA signature
  certificate: string;     // PEM-encoded X.509 certificate
}

/** Structure of .signatures.json manifest */
export interface SigningManifestFormat {
  version: 1;
  signedAt: string;        // ISO 8601 timestamp
  certificate: string;     // PEM-encoded X.509 certificate
  certificateFingerprint: string; // "SHA256:<hex>"
  files: SigningManifestEntry[];
}

export interface SigningManifestEntry {
  path: string;            // relative path to signed file
  signatureFile: string;   // relative path to .sig file
  algorithm: 'SHA256';
  signature: string;       // base64-encoded signature
}