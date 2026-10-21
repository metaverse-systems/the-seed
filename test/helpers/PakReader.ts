/*
 * Reads resource paks back for the tests: with the native component's reader (libthe-seed's own) and by parsing the
 * description line.
 *
 * Interfaces fixed here where the contracts leave them open:
 * - `readResourcePak` is looked up on the loaded component when it is called, not when this module is loaded, so
 *   a component that was built before the function existed still loads and the cases that need it fail with a
 *   message saying the function is absent.
 * - `nativeReaderAvailable()` is true when the component loads and offers `readResourcePak`; the round trip
 *   cases are skipped (or required, under THE_SEED_REQUIRE_TOOLS=1) through it.
 * - `readDescriptionLine` returns the bytes of the first line including the terminating newline, their count, and the
 *   parsed JSON; it throws when the file has no newline.
 */
import fs from "fs";
import { loadNativeComponent } from "../../src/NativeComponent";

/** What the reader returns: the resource names in order and the bytes of each resource. */
export interface ReadPak {
  names: string[];
  resources: Buffer[];
}

/** The first line of a pak. */
export interface DescriptionLine {
  /** The line's bytes, the newline included */
  bytes: Buffer;
  /** The line's length in bytes, the newline included */
  byteLength: number;
  /** The line parsed as JSON */
  json: {
    name: string;
    headerSize: string;
    resources: Array<{ name: string; size: number; attributes?: { [key: string]: string } }>;
  };
}

interface ComponentWithReader {
  readResourcePak?: (file: string) => ReadPak;
}

function component(): ComponentWithReader | null {
  try {
    return loadNativeComponent<ComponentWithReader>();
  } catch {
    return null;
  }
}

/** True when the native component loads and has the pak reader. */
export function nativeReaderAvailable(): boolean {
  const loaded = component();
  return loaded !== null && typeof loaded.readResourcePak === "function";
}

/** Why the reader cannot be used, for the message of a skipped check. */
export function nativeReaderUnavailableReason(): string {
  return "the native component is not built or cannot be loaded (build it with: npm run build-addon)";
}

/** Opens the pak with libthe-seed's reader. Throws the reader's own message when the pak is refused. */
export function readResourcePak(file: string): ReadPak {
  const loaded = component();
  if (loaded === null) {
    throw new Error(nativeReaderUnavailableReason());
  }
  if (typeof loaded.readResourcePak !== "function") {
    throw new Error("the native component has no readResourcePak function (rebuild it with: npm run build-addon)");
  }
  return loaded.readResourcePak(file);
}

/** The pak's first line: its bytes, its byte length and the parsed JSON. */
export function readDescriptionLine(file: string): DescriptionLine {
  const content = fs.readFileSync(file);
  const end = content.indexOf(0x0a);
  if (end < 0) {
    throw new Error(file + " has no description line");
  }
  const bytes = content.subarray(0, end + 1);
  return { bytes, byteLength: bytes.length, json: JSON.parse(bytes.toString("utf8")) };
}
