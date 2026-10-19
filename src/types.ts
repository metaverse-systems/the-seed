import type { StepOutputMode } from "./StepRunner";

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
  [key: string]: unknown;
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
  /** Libraries that were found but could not be read; absent when an older addon is used */
  libraryErrors?: Record<string, { reason: string; inputs: string[] }>;
}

export interface BuildStep {
  /** Human-readable step name (e.g., 'autogen', 'configure', 'compile', 'install') */
  label: string;
  /** Program to run; never interpreted by a shell */
  program: string;
  /** Arguments passed to the program as they are */
  args: string[];
  /** Working directory, relative to the project directory; the project directory when omitted */
  cwd?: string;
  /** Environment values laid over the inherited environment */
  env?: Record<string, string>;
  /** If true, non-zero exit codes do not abort the build (used for 'make distclean') */
  ignoreExitCode?: boolean;
}

// ── Code Signing Types ──────────────────────────────────────

/** How a file's signature is stored */
export type SignatureType = "embedded" | "detached";

/** Detected binary format */
export type BinaryFormat = "pe" | "macho" | "msi" | "other";

/** Detailed format detection result */
export interface FormatDetectionResult {
  format: BinaryFormat;
  subFormat: "pe32" | "pe32+" | "macho32" | "macho64" | "fat" | null;
}

/** The CodeDirectory of one slice of a Mach-O file, as computed by the library */
export interface MachOPreparedSlice {
  cpuType: number;
  cpuSubtype: number;
  codeDirectory: Buffer;
  cdHash: Buffer;
}

/** What machoPrepareSignature returns and machoCompleteSignature takes back */
export interface MachOPreparedSignature {
  identity: string;
  cmsCapacity: number;
  slices: MachOPreparedSlice[];
}

/** Options for signing operations */
export interface SignOptions {
  force?: boolean;
  scope?: string;
  detached?: boolean;
}

export interface CertSubject {
  commonName: string;
  email?: string;
  organization?: string;
}

export interface CertOptions {
  validityDays?: number; // default: 365
  scope?: string;        // scope name to use for subject fields
}

export interface CertInfo {
  subject: CertSubject;
  issuer: string;       // "self-signed" or CA distinguished name
  fingerprint: string;  // "SHA256:<hex>"
  keyType: string;      // "ECDSA P-256"
  notBefore: Date;
  notAfter: Date;
  isExpired: boolean;
  isNotYetValid: boolean; // validity period has not started
  certPath: string;     // absolute path to cert.pem
}

/** Which kind of signature a verification looked at. */
export type SignatureForm = "detached" | "windows-program" | "installer" | "mac-program";

export type IntegrityState = "intact" | "invalid" | "not-checked" | "none";

export interface IntegrityResult {
  state: IntegrityState;
  reason?: string;           // present for invalid and not-checked
  checked: string[];         // what was checked
  unsignedOnly?: string[];   // set only on an invalid Mac result whose sole defect is unsigned slices
}

export type TrustAnchor =
  | { source: "scope"; scope: string; fingerprint: string; certPath: string }
  | { source: "supplied"; path: string; fingerprint: string };

export interface TrustedCertificates {
  source: "scopes" | "supplied";
  anchors: TrustAnchor[];
  warnings: string[];
}

export type TrustState = "trusted" | "untrusted" | "not-applicable";
export type UntrustedReason = "unknown-signer" | "no-signer" | "no-trusted-certificates";

export interface TrustResult {
  state: TrustState;
  anchor?: TrustAnchor;        // set when trusted
  reason?: UntrustedReason;    // set when untrusted
  message?: string;            // the sentence printed for an untrusted result
}

export interface MachOSliceResult {
  arch: string;               // "arm64", "x86_64" or "0x<cputype>"
  cpuType: number;
  offset: number;             // in the file
  size: number;
  state: "intact" | "invalid" | "unsigned" | "not-checked";
  reason?: string;
  codeDirectories: Array<{ slot: number; hashType: "sha1" | "sha256" | "sha384"; pages: number; pagesMismatched: number; codeLimit: number }>;
  adHoc: boolean;             // no CMS signer
  signerFingerprint?: string;
}

export interface VerifyOptions {
  trust?: TrustedCertificates;
}

export interface SignResult {
  filePath: string;              // path to the original file
  signaturePath: string | null;  // path to .sig file, null when embedded
  fingerprint: string;           // certificate fingerprint
  signatureType: SignatureType;  // "embedded" or "detached"
  warnings: string[];            // e.g., "Removed stale .sig file"
}

export interface DirectorySignResult {
  manifestPath: string;   // path to .signatures.json
  signed: SignResult[];   // list of signed files
  skipped: string[];      // list of skipped (non-binary) files
}

export type VerifyStatus = "VALID" | "UNTRUSTED" | "INVALID" | "NOT_FULLY_SIGNED" | "NOT_CHECKED" | "NOT_FOUND";

export interface VerifyResult {
  filePath: string;
  status: VerifyStatus;
  reason?: string;               // the deciding reason: the integrity reason, or the trust message for UNTRUSTED
  form?: SignatureForm;          // absent when NOT_FOUND
  signatureType?: SignatureType; // "embedded" or "detached"
  integrity: IntegrityResult;
  trust: TrustResult;
  signer?: CertInfo;             // certificate info of the signer (if a signature exists)
  slices?: MachOSliceResult[];   // Mac programs
  signatures?: VerifyResult[];   // both kinds present: [embedded, detached]; the top level is the worse
  warnings: string[];            // e.g., "Both embedded and detached signatures found"
  notChecked: string[];          // what this verification does not cover: the fixed list first, then file-specific items
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
  algorithm: "SHA256";
  curve: "P-256";
  signature: string;       // base64-encoded ECDSA signature
  certificate: string;     // PEM-encoded X.509 certificate
}

/** Structure of .signatures.json manifest */
export interface SigningManifestFormat {
  version: 1 | 2;
  signedAt: string;        // ISO 8601 timestamp
  certificate: string;     // PEM-encoded X.509 certificate
  certificateFingerprint: string; // "SHA256:<hex>"
  files: SigningManifestEntry[];
}

export interface SigningManifestEntry {
  path: string;                     // relative path to signed file
  signatureFile: string | null;     // relative path to .sig file, null when embedded
  algorithm: "SHA256";
  signature: string;                // base64-encoded signature
  signatureType: SignatureType;     // "embedded" or "detached"
}

// ── Recursive Build Types ───────────────────────────────────

/**
 * Classifies a buildable project's role in the build tier ordering.
 * Numeric values represent tier rank for priority sorting.
 */
export enum ProjectType {
  /** Library with lib_LTLIBRARIES; configure.ac does NOT reference the-seed in PKG_CHECK_MODULES */
  Component = 0,
  /** Library with lib_LTLIBRARIES; configure.ac DOES reference the-seed in PKG_CHECK_MODULES */
  System = 1,
  /** Executable with bin_PROGRAMS */
  Program = 2,
}

/** A discovered project that can be built with the autotools pipeline. */
export interface BuildableProject {
  /** Package name from package.json (e.g., "@org/physics-system") */
  name: string;
  /** Absolute filesystem path to the project root directory */
  path: string;
  /** Tier classification derived from src/Makefile.am + configure.ac */
  type: ProjectType;
  /** Package names of buildable dependencies */
  dependencies: string[];
}

/** A directed acyclic graph of BuildableProject nodes. */
export interface DependencyGraph {
  /** All discovered projects, keyed by absolute path (deduplicates diamond deps) */
  projects: Map<string, BuildableProject>;
  /** Adjacency list: project path → paths of its buildable dependencies */
  edges: Map<string, string[]>;
}

/** The outcome of a recursive build execution. */
export interface RecursiveBuildResult {
  /** true if all projects built successfully */
  success: boolean;
  /** Projects that built successfully, in build order */
  completed: BuildableProject[];
  /** The project that failed, or null if all succeeded */
  failed: BuildableProject | null;
  /** Stderr/stdout from the failed build step, or null */
  failureOutput: string | null;
  /**
   * Every project that is neither completed nor the first failure, in build
   * order, so that completed + remaining + (failed ? 1 : 0) equals the total.
   */
  remaining: BuildableProject[];
  /** true if the build was cancelled by user */
  cancelled: boolean;
  /** Every failure in the order it happened; `failed` and `failureOutput` describe the first */
  failures: ProjectFailure[];
  /** Projects that had started and were stopped by cancellation */
  interrupted: BuildableProject[];
  /** Projects that never began because the build stopped first */
  notStarted: BuildableProject[];
}

/** One project's failure in a recursive build. */
export interface ProjectFailure {
  /** The project that failed */
  project: BuildableProject;
  /** Label of the step that failed (autogen, configure, compile, install, strip, sign or place) */
  step: string;
  /** Full captured output of the failed command, or the error message for strip, sign and place */
  output: string;
}

/** Callbacks for reporting recursive build progress. */
export interface RecursiveBuildCallbacks {
  /** Called when starting a new project build */
  onProjectStart?: (project: BuildableProject, index: number, total: number) => void;
  /** Called when a project build step completes */
  onStepComplete?: (project: BuildableProject, step: BuildStep) => void;
  /** Called when a project finishes building successfully */
  onProjectComplete?: (project: BuildableProject, index: number, total: number) => void;
}

/** Configuration options for a recursive build execution. */
export interface RecursiveBuildOptions {
  /** Build target: 'native' or 'windows' */
  target: string;
  /** If true, run full reconfigure (autogen + configure) for each project */
  fullReconfigure: boolean;
  /** Absolute path of the root project (cwd for the-seed CLI invocation) */
  projectDir: string;
  /** Optional AbortSignal for cancellation support */
  signal?: AbortSignal;
  /** Optional progress/status callbacks */
  callbacks?: RecursiveBuildCallbacks;
  /** When true, the install phase strips the installed programs and libraries (and their build-tree copies) before signing them. Defaults to false. */
  release?: boolean;
  /**
   * Maximum number of projects to build at once (a positive integer, capped
   * at the processor count). Defaults to 1, which builds one project at a time.
   */
  parallel?: number;
  /**
   * Compile jobs to share among the projects building at once (a positive
   * integer). Defaults to the processor count.
   */
  jobs?: number;
  /**
   * Optional second, forced cancellation. Aborting `signal` stops running
   * steps but lets an install phase in progress finish and place its files;
   * aborting this also discards an install phase that has not reached
   * placement.
   */
  forceSignal?: AbortSignal;
}

/** The parsed arguments of `the-seed build`. */
export interface BuildRequest {
  /** "incremental" when no target is given, "full" for native or windows */
  mode: "help" | "incremental" | "full";
  /** Set only when mode is "full" */
  target?: "native" | "windows";
  /** Build every buildable dependency first */
  recursive: boolean;
  /** Strip the installed programs and libraries (and the build-tree copies "package" reads) before they are signed */
  release: boolean;
  /** Maximum number of projects to build at once; 1 unless --parallel was given */
  parallel: number;
  /** Compile job limit; absent unless --jobs was given */
  jobs?: number;
  /** The deprecated bare word "recursive" was used */
  deprecatedBareWord: boolean;
}

/** Options for Build.buildProject(), a plain or incremental build of one project. */
export interface ProjectBuildOptions {
  /** The project directory every step runs in */
  projectDir: string;
  /** Absent for an incremental build (compile and install only) */
  target?: "native" | "windows";
  /** Strip the programs and libraries in the install phase, before they are signed (needs a target) */
  release: boolean;
  /** Compile job limit */
  jobs?: number;
  /** Directory holding the signing certificates */
  configDir: string;
  /** Base environment for every step; process.env when omitted */
  env?: NodeJS.ProcessEnv;
  /** First cancellation: stops every step except the install phase (staged install, strip, sign, placement) */
  signal?: AbortSignal;
  /** Second cancellation: also discards an install phase that has not reached placement */
  forceSignal?: AbortSignal;
  /** Receives each step's output as it arrives; the tool's own streams when omitted */
  output?: { stdout(chunk: Buffer): void; stderr(chunk: Buffer): void };
  /** Receives each progress line; console.log when omitted */
  log?: (line: string) => void;
  /** Called before each step, the install step included; `index` is 0-based */
  onStepStart?(step: BuildStep, index: number, total: number): void;
}

/** How Build.buildProject() ended. */
export type ProjectBuildResult =
  | { status: "completed" }
  /** `step` is a build step label (install included), or strip, sign or place from the install phase */
  | { status: "failed"; step: string; message: string }
  /** `installed` is set when the install phase finished and placed its files before the build stopped */
  | { status: "cancelled"; installed?: true };

/** What a file is for a build target. */
export type OutputKind = "elfExecutable" | "elfShared" | "peProgram" | "peLibrary";

/** One entry under the staged prefix root. `relPath` is relative to the root and uses "/". */
export interface StagedEntry {
  relPath: string;
  type: "dir" | "file" | "symlink";
  mode: number;
  linkTarget?: string;
  dev: number;
  ino: number;
}

/** The result of reading the stage after the install step. */
export interface StagedTree {
  /** The DESTDIR given to the install step */
  stageDir: string;
  target: "native" | "windows";
  /** <config prefix>/<triplet> */
  prefix: string;
  /** stageDir + prefix */
  root: string;
  /** Every entry under root, depth first, directories before their contents */
  entries: StagedEntry[];
}

/** One program or library output and every name it has. */
export interface OutputGroup {
  /** Absolute path of the real file */
  file: string;
  kind: OutputKind;
  /** Absolute path of every name: the file, each symlink in a chain that ends at it, each hard link */
  names: string[];
  /** The symlink names with their readlink text */
  links: { path: string; target: string }[];
  /** The hard-link names other than file */
  hardLinks: string[];
  /** The path printed in progress lines */
  display: string;
}

/** Whether a project is signed, and if not, why. */
export type SigningOutcome =
  | { kind: "signed"; scope: string }
  | {
      kind: "unsigned";
      reason: "noPackageJson" | "unreadablePackageJson" | "noScope" | "noCertificate" | "expired";
      scope?: string;
      name?: string;
      expiredOn?: Date;
      detail?: string;
    };

/** What a successful install phase did. */
export interface InstallReport {
  prefix: string;
  installed: number;
  stripped: string[];
  signed: { display: string; form: "embedded" | "detached" }[];
  outcome: SigningOutcome;
}

/** Options for the install phase of one project. */
export interface InstallPhaseOptions {
  projectDir: string;
  /** config.config.prefix */
  configPrefix: string;
  /** Directory holding the signing certificates */
  configDir: string;
  /** Absent for an incremental build */
  target?: "native" | "windows";
  /** Strip only when true and a target is given */
  release: boolean;
  /** The install step; DESTDIR is appended */
  installStep: BuildStep;
  /** Base environment of the step */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  output: StepOutputMode;
  /** One whole line per call */
  log: (line: string) => void;
  /** Called once, right after the install step succeeds */
  onInstalled?: () => void;
}

/** How the install phase ended. */
export type InstallPhaseResult =
  | { status: "completed"; report: InstallReport }
  | { status: "failed"; step: "install" | "strip" | "sign" | "place"; message: string; output?: string }
  | { status: "interrupted" };
