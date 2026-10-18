/** Fails the case with "<what> is missing" when value is null or undefined; returns it narrowed. */
export function expectPresent<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(what + " is missing");
  }
  return value;
}
