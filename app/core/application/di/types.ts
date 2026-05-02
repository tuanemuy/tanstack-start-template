import type { UnitOfWorkProvider } from "../execution/unitOfWork";
import type { Clock } from "../ports/clock";
import type { IdGenerator } from "../ports/idGenerator";
import type { Logger } from "../ports/logger";
import type { OutboxRepository } from "../ports/outboxRepository";

export type AppConfig = Readonly<{
  appUrl: string;
  siteName: string;
  defaultTitle: string;
  defaultDescription: string;
  twitterHandle?: string;
  themeColor: string;
}>;

export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  outboxRepository: OutboxRepository;
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
  shutdown: () => Promise<void>;
};

export type ServerConfig = AppConfig &
  Readonly<{
    databaseUrl: string;
  }>;
