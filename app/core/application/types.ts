import type { Container } from "./di/server";

/**
 * Arguments for an application service that takes typed input. Usecases
 * with optional input define their own argument shape inline (see
 * `listTodos`) so callers don't have to write `input: undefined`.
 */
export type ServiceArgs<T> = {
  container: Container;
  input: T;
};
