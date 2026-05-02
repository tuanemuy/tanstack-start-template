import { createStart } from "@tanstack/react-start";
import { appServerErrorAdapter } from "@/core/presentation/appServerErrorAdapter";

export const startInstance = createStart(() => ({
  serializationAdapters: [appServerErrorAdapter],
}));
