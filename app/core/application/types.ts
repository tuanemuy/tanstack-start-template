import type { Container } from "./di/server";

/**
 * Arguments for an application service that does not need request-scoped
 * HTTP context (headers, auth, etc.).
 *
 * Prefer this over {@link AuthedServiceArgs} for any usecase that can execute
 * in a vacuum: list/get queries, side-job workers, seed scripts, etc.
 *
 * Example:
 * ```ts
 * export async function createTodo({
 *   container,
 *   input,
 * }: ServiceArgs<CreateTodoInput>): Promise<CreateTodoOutput> { ... }
 * ```
 */
export type ServiceArgs<T = undefined> = {
  container: Container;
  input: T;
};

/**
 * Arguments for an application service that needs the caller's HTTP headers
 * (session cookies, Authorization header, tracing, etc.).
 *
 * Usecases that implement authorization, audit logging keyed on the current
 * user, or request tracing should accept this instead of {@link ServiceArgs}.
 * The presentation layer is expected to obtain headers via
 * `getRequestHeaders()` from `@tanstack/react-start/server` and pass them
 * through unchanged.
 *
 * Example (with a hypothetical `authProvider` port):
 * ```ts
 * export async function createPost({
 *   container,
 *   headers,
 *   input,
 * }: AuthedServiceArgs<CreatePostInput>): Promise<CreatePostOutput> {
 *   const user = await container.authProvider.getCurrentUser(headers);
 *   if (!user) throw new UnauthenticatedError(...);
 *   // ...
 * }
 * ```
 */
export type AuthedServiceArgs<T = undefined> = {
  container: Container;
  headers: Headers;
  input: T;
};
