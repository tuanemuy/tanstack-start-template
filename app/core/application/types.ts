import type { Container } from "./container/server";

export type ServiceArgs<T = undefined> = {
  container: Container;
  headers: Headers;
  input: T;
};
