import type { Container } from "./di/types";

export type ServiceArgs<T> = {
  container: Container;
  input: T;
};
