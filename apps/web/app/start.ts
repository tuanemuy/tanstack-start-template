import { createStart } from "@tanstack/react-start";
import { appServerErrorAdapter } from "@/presentation/appServerErrorAdapter";

export const startInstance = createStart(() => ({
  serializationAdapters: [appServerErrorAdapter],
}));
