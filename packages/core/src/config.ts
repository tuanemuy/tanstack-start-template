import type { AppConfig } from "@repo/core/application/di/types";

export const content: Omit<AppConfig, "appUrl"> = {
  siteName: "TanStack Start Template",
  defaultTitle: "TanStack Start Template",
  defaultDescription:
    "Hexagonal-architecture starter for TanStack Start with React Server Components.",
  themeColor: "#ffffff",
  // twitterHandle: "@example",
};
