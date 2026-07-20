import { createSerializationAdapter } from "@tanstack/react-router";
import { AppServerError, type SerializedError } from "./errorResponse";

// Registered on the global start instance so `AppServerError` survives the
// Seroval roundtrip with class identity intact. Without this, the client
// receives a plain `Error` whose `serialized` property is preserved as an own
// field but `instanceof AppServerError` is false.
export const appServerErrorAdapter = createSerializationAdapter<
  AppServerError,
  SerializedError
>({
  key: "AppServerError",
  test: (value): value is AppServerError => value instanceof AppServerError,
  toSerializable: (value) => value.serialized,
  fromSerializable: (value) => new AppServerError(value),
});
