import type { RequestContainer } from "./di/types";

export type ServiceArgs<T> = {
  container: RequestContainer;
  input: T;
};
