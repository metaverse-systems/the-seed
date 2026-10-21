/*
 * Helpers for asserting the typed errors the signing library throws.
 *
 * `SigningError` is looked up on the module at run time, so a test file that uses these helpers
 * still compiles and loads while the class does not exist yet; each case then fails with a message
 * saying so.
 */
import * as SigningModule from "../../src/Signing";

/** The fields of a `SigningError` the tests read. */
export interface SigningErrorLike extends Error {
  code: string;
  hint?: string;
}

type ErrorClass = new (...args: never[]) => Error;

/** The `SigningError` class of the module under test, when it exists. */
export function signingErrorClass(): ErrorClass | undefined {
  return (SigningModule as unknown as { SigningError?: ErrorClass }).SigningError;
}

/** Runs the action and returns what it threw; fails the case when nothing was thrown or it is not a `SigningError`. */
export async function signingErrorOf(action: () => unknown): Promise<SigningErrorLike> {
  let thrown: unknown;
  let completed = false;
  try {
    await action();
    completed = true;
  } catch (error: unknown) {
    thrown = error;
  }
  if (completed) {
    throw new Error("expected the action to throw a SigningError, but it completed");
  }
  const errorClass = signingErrorClass();
  if (errorClass === undefined) {
    throw new Error("SigningError is not exported from src/Signing.ts; the action threw: " + String(thrown));
  }
  if (!(thrown instanceof errorClass)) {
    throw new Error("expected a SigningError but the action threw " + String((thrown as Error)?.name) + ": " + String((thrown as Error)?.message));
  }
  return thrown as SigningErrorLike;
}
