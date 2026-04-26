import type { Container } from "./di/server";

/**
 * Arguments for an application service.
 *
 * Every usecase receives the DI container plus its typed input. If a future
 * usecase needs request-scoped HTTP context (session cookies, Authorization
 * header, tracing), introduce a dedicated args type alongside an `auth` port
 * at that point — the template intentionally does not ship a placeholder
 * `AuthedServiceArgs` to avoid an unused abstraction.
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
