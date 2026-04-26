# Backend Implementation Guide

このテンプレートのバックエンド層は **ヘキサゴナル + DDD + Outbox パターン** で構成されている。
Todo ドメインの実装が canonical example。新しいドメインを足すときも同じ構造をなぞれば良い。

## レイヤー責務一覧

| レイヤー | 責務 | 依存方向 |
|---|---|---|
| Domain | エンティティ / 値オブジェクト / ドメインイベント / ポート定義 | 何にも依存しない |
| Application | usecase オーケストレーション / DI / Outbox 連携 | → Domain |
| Adapter | DB / 外部 API の具体実装 | → Domain (port を実装) |
| Presentation | server function 境界 / エラーシリアライズ | → Application |

## ファイル配置

```
app/core/
├── domain/
│   ├── common/
│   │   ├── event.ts               DomainEventBase, EventDecoder, WithEvents
│   │   ├── pagination.ts
│   │   └── ports/outboxRepository.ts
│   ├── error.ts                   BusinessRuleError
│   └── ${domain}/
│       ├── entity.ts
│       ├── valueObject.ts
│       ├── events.ts
│       ├── errorCode.ts
│       └── ports/${domain}Repository.ts
├── application/
│   ├── di/server.ts               Container, createContainer, getContainer
│   ├── ports/
│   │   ├── clock.ts
│   │   └── logger.ts
│   ├── errors/index.ts
│   ├── execution/
│   │   ├── unitOfWork.ts
│   │   └── retry.ts
│   ├── workers/eventRelayWorker.ts
│   └── ${domain}/
│       ├── view.ts                Aggregate → DTO 射影
│       ├── ${usecase}.ts          1 usecase 1 ファイル
│       └── __tests__/
└── adapters/
    └── drizzleSqlite/
        ├── client.ts
        ├── schema.ts
        ├── unitOfWork.ts
        ├── repositories/
        │   ├── helpers.ts          mapDbError
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/
```

## Domain Layer

### Value Object（ブランド型 + factory）

```ts
// app/core/domain/${domain}/valueObject.ts
declare const fooIdBrand: unique symbol;
export type FooId = string & { readonly [fooIdBrand]: true };

export const FooId = {
  create: (id: string): FooId => {
    if (!UUID_V7_PATTERN.test(id)) {
      throw new BusinessRuleError(FooErrorCode.InvalidId, "Invalid foo id");
    }
    return id as FooId;
  },
  generate: (): FooId => uuidv7() as FooId,
};
```

ポイント:
- `unique symbol` で nominal typing
- factory が唯一の作成経路（`as FooId` キャストは boundary でしか書かない）
- 不正値は `BusinessRuleError` を throw（Result 型は使わない）

### Entity（discriminated union + WithEvents）

```ts
// app/core/domain/${domain}/entity.ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (params: { ... }, now: Date): WithEvents<ActiveFoo, FooEvent> => {
    const foo: ActiveFoo = { ...params, version: 0, createdAt: now, updatedAt: now };
    return { entity: foo, events: [FooEvents.created(foo.id, now)] };
  },

  complete: (foo: ActiveFoo, now: Date): WithEvents<CompletedFoo, FooEvent> => { ... },

  delete: (foo: Foo, now: Date): WithEvents<null, FooEvent> => ({
    entity: null,
    events: [FooEvents.deleted(foo.id, now)],
  }),
};
```

ポイント:
- 状態を discriminated union で表現 → 不正な遷移は型エラー
- `now: Date` を引数で受ける（domain は `new Date()` を呼ばない）
- 状態遷移は `WithEvents<TEntity, TEvent>` を返してイベントとセットで扱う
- 削除は `WithEvents<null, ...>`

### Domain Event

```ts
// app/core/domain/${domain}/events.ts
export type FooCreatedEvent = DomainEventBase<
  "foo.created",
  Readonly<{ fooId: FooId }>
>;

export type FooEvent = FooCreatedEvent | FooDeletedEvent;

export const FooEvents = {
  created: (fooId: FooId, now: Date): FooCreatedEvent => ({
    id: uuidv7(),
    type: "foo.created",
    payload: { fooId },
    occurredAt: now,
    aggregateId: fooId,
  }),
};

export const decodeFooEvent: EventDecoder<FooEvent> = (type, payload, meta) => {
  switch (type) {
    case "foo.created": {
      const parsed = fooCreatedPayloadSchema.parse(payload);
      return {
        ...meta,
        type: "foo.created",
        payload: { fooId: FooId.create(parsed.fooId) },
      };
    }
    default:
      throw new BusinessRuleError(FooErrorCode.UnknownEventType, `Unknown: ${type}`);
  }
};
```

ポイント:
- decoder は throw する（relay worker が per-row catch してログに流す）
- payload schema は `z.object(...).strict()` で extra field を拒否
- ブランド型は decoder で `FooId.create(parsed.fooId)` を経由して再構築

### Repository Port

```ts
// app/core/domain/${domain}/ports/${domain}Repository.ts
export interface FooRepository {
  findById(id: FooId): Promise<Foo | null>;
  findPage(pagination: Pagination): Promise<PaginationResult<Foo>>;
  save(foo: Foo): Promise<void>;                   // OCC: WHERE version = old
  delete(id: FooId, expectedVersion: number): Promise<void>;
}
```

## Application Layer

### Usecase

```ts
// app/core/application/${domain}/createFoo.ts
export async function createFoo({
  container,
  input,
}: ServiceArgs<CreateFooInput>): Promise<CreateFooOutput> {
  const now = container.clock.now();
  const { entity: foo, events } = Foo.create(input, now);

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      await fooRepository.save(foo);
      collectEvents(events);
    },
  );

  return { foo: toFooView(foo) };
}
```

ポイント:
- `now` は usecase 冒頭で 1 回だけ取って domain に渡す（domain は clock 触らない）
- `collectEvents` で Outbox パターンに乗せる（同一 tx で flush）
- 戻り値は DTO（`view.ts` 内の helper で射影）

冪等な「set X」系 usecase は `retry()` で OCC conflict を吸収する。詳細は `app/core/application/todo/changeTodoStatus.ts` 参照。

### Container 配線

```ts
// app/core/application/di/server.ts
export async function createContainer(config: ServerConfig): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(db),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    logger: ConsoleLogger,
  };
}
```

`SQLITE_BUSY` 等の transient lock contention は `DrizzleSqliteUnitOfWorkProvider` が内部で retry する（driver-level concern なので application 層は触らない）。

## Adapter Layer

### Repository（OCC 実装）

```ts
async save(foo: Foo): Promise<void> {
  if (foo.version === 0) {
    await this.executor.insert(foos).values({ ...foo });
    return;
  }
  const updated = await this.executor
    .update(foos)
    .set({ ...foo })
    .where(and(eq(foos.id, foo.id), eq(foos.version, foo.version - 1)))
    .returning({ id: foos.id });
  if (updated.length === 0) {
    throw new ConflictError(
      ConflictErrorCode.OptimisticLockFailure,
      `Optimistic lock failure: ${foo.id}`,
    );
  }
}
```

ポイント:
- 0 件 update → `ConflictError(OptimisticLockFailure)`
- DB 例外は `mapDbError` で `SystemError(DatabaseError)` に変換
- upsert (`ON CONFLICT DO UPDATE`) は使わない（lost update を隠すため）

### Unit of Work

`app/core/adapters/drizzleSqlite/unitOfWork.ts` が `UnitOfWorkProvider.run(fn)` を実装する:

1. `db.transaction(...)` を開く
2. tx 内で repository / outbox インスタンスを構築
3. `collectEvents` のバッファを集めるコンテキストを fn に渡す
4. fn 解決後、collected events を outbox に save（同一 tx）

`SQLITE_BUSY` / `SQLITE_LOCKED` は driver-level の implementation detail なので、adapter が `run()` 内部で `retry()` を使って exponential backoff retry する。application 層・他の adapter へ leak させない。アプリ側の OCC retry（`changeTodoStatus` 内の `ConflictError(OptimisticLockFailure)` retry）とは別レイヤー・別エラークラスなので二重 retry は起きない。

## Outbox Worker

```ts
import { processOutboxEvents } from "@/core/application/workers/eventRelayWorker";

await processOutboxEvents(container, async (event) => {
  // event.type で switch して下流ハンドラへ dispatch
}, { batchSize: 100 });
```

ポイント:
- 単一プロセス前提（multi-worker でスケールしたいなら lease を別途追加）
- consumer は `event.id` ベースで冪等に書く（at-least-once delivery）
- decode / dispatch 失敗は logger に出して row を pending のまま残す（次の poll で再試行）

新しいドメインの decoder は `defaultEventDecoderRegistry` に prefix で登録すれば自動的に拾われる。

## エラー設計

| レイヤー | エラー型 | 例 |
|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | 不正な title、未知の event type |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, `SystemError`, ... | usecase ロジックで決まる失敗 |
| Adapter | 上記を throw | OCC 失敗 → `ConflictError`、DB 例外 → `SystemError` |
| Presentation | `AppServerError` でラップして wire 化 | `withErrorResponse` |

各エラークラスは `toSerialized(): SerializedError` を実装する（structural な `SerializableError` プロトコル）。新しいエラー型を足しても presentation の `serializeError` は触らなくて良い。
