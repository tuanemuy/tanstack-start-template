import type { UnitOfWorkProvider } from "../unitOfWork";

/**
 * Application Configuration
 */
export type AppConfig = {
  appUrl: string;
};

/**
 * Dependency Injection Container
 */
export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  // ... other dependencies
};
