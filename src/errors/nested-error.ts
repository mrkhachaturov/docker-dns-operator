import { getLogClassDecorator } from '../utility.functions';

const LogDecorator = getLogClassDecorator();

/**
 * Encapsulates an error and overrides the message.
 * Allows for nested error stacks.
 *
 * Accepts `unknown` because `catch` binds the variable as `unknown` under
 * TypeScript's `useUnknownInCatchVariables` (default on since TS 5+) — and
 * JS can legitimately throw non-Error values. Non-Error throwables are
 * normalised into `new Error(String(value))` so the inner stack stays
 * uniform; Error instances pass through by reference.
 */
@LogDecorator()
export class NestedError extends Error {
  private nestedError: Error;

  constructor(message: string, nestedError: unknown) {
    const inner =
      nestedError instanceof Error
        ? nestedError
        : new Error(String(nestedError));
    super(
      `${message}. innerError: { name: '${inner.name}', message: '${inner.message}' }`,
    );
    this.nestedError = inner;
  }

  /**
   * Exposes the nested error.
   */
  get NestedError(): Error {
    return this.nestedError;
  }
}
