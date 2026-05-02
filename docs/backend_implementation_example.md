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
│   │   └── pagination.ts
│   ├── error.ts                   BusinessRuleError
│   └── ${domain}/
│       ├── entity.ts
│       ├── valueObject.ts
│       ├── events.ts
│       ├── errorCode.ts
│       └── ports/${domain}Repository.ts
├── application/
│   ├── di/server.ts               Container, createContainer, getContainer, readServerConfig
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── idGenerator.ts
│   │   ├── logger.ts
│   │   └── outboxRepository.ts
│   ├── errors/index.ts            NotFound / Conflict / Validation / SystemError + helpers
│   ├── execution/unitOfWork.ts    UnitOfWorkContext がリポジトリスロットを直接 enumerate
│   ├── workers/
│   │   ├── eventRelayWorker.ts
│   │   └── outboxPrune.ts
│   ├── types.ts                   ServiceArgs<T>
│   └── ${domain}/
│       ├── view.ts
│       ├── ${usecase}.ts
│       └── __tests__/
├── presentation/
│   ├── errorResponse.ts             AppServerError, serializeError, extractSerializedError, httpStatusFor
│   ├── errorResponseMiddleware.ts   errorResponseMiddleware (wraps inputValidator + handler)
│   ├── serverFn.ts                  defineServerFn (canonical createServerFn entry, pre-applies the middleware)
│   ├── errorDisplay.ts            displayError, sanitizeRouteError
│   └── validator.ts               validateInput(schema) — transport-boundary shape check
└── adapters/
    └── drizzleSqlite/
        ├── client.ts
        ├── schema.ts
        ├── unitOfWork.ts          tx 内で各リポジトリを new して UoW context を組む
        ├── repositories/
        │   ├── helpers.ts         mapDbError
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/

app/lib/
├── error.ts                       CodedError 基底 + SerializedErrorBase / FieldErrors / SerializableError interface（構造のみ。union は presentation で組立）
└── path.ts
```

## Domain Layer

### Value Object

```ts
declare const fooIdBrand: unique symbol;
export type FooId = string & { readonly [fooIdBrand]: true };

export const FooId = {
  create: (id: string): FooId => {
    if (!UUID_V7_PATTERN.test(id)) {
      throw new BusinessRuleError(FooErrorCode.InvalidId, "Invalid foo id");
    }
    return id as FooId;
  },
};
```

ポイント:
- `unique symbol` で nominal typing
- factory が唯一の作成経路
- 不正値は `BusinessRuleError` を throw（Result 型は使わない）
- **`generate()` は置かない**。id 生成は application 層の `IdGenerator` port 経由

### Entity

```ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (
    params: { id: string; eventId: string; /* ...domain inputs... */ },
    now: Date,
  ): WithEvents<ActiveFoo, FooEvent> => {
    const id = FooId.create(params.id);
    const foo: ActiveFoo = { ...params, id, version: 0, createdAt: now, updatedAt: now };
    return { entity: foo, events: [FooEvents.created(params.eventId, foo.id, now)] };
  },

  complete: (
    foo: ActiveFoo,
    eventId: string,
    now: Date,
  ): WithEvents<CompletedFoo, FooEvent> => {
    const next: CompletedFoo = { ...foo, status: "completed", version: foo.version + 1, updatedAt: now };
    return { entity: next, events: [FooEvents.completed(eventId, next.id, now)] };
  },
};
```

ポイント:
- 状態を discriminated union で表現 → 不正な遷移は型エラー
- `Todo.create` のように **VO 生成は entity factory に集約**（application 層は raw string を渡す）
- `now: Date` と必要な `id` / `eventId` を引数で受ける（domain は `new Date()` も `uuidv7()` も呼ばない）
- 状態遷移は `WithEvents<TEntity, TEvent>` を返してイベントとセットで扱う
- 削除のように後続エンティティが無い操作は domain にメソッドを置かず、usecase が
  `FooEvents.deleted(...)` を直接 emit する

### Domain Event

```ts
export type FooCreatedEvent = DomainEventBase<
  "foo.created",
  Readonly<{ fooId: FooId }>
>;

export type FooEvent = FooCreatedEvent | FooDeletedEvent;

export const FooEvents = {
  created: (id: string, fooId: FooId, occurredAt: Date): FooCreatedEvent => ({
    id,
    type: "foo.created",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),

  deleted: (id: string, fooId: FooId, occurredAt: Date): FooDeletedEvent => ({
    id,
    type: "foo.deleted",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),
};

export const fooEventDecoders: Readonly<
  Record<FooEvent["type"], EventDecoder<FooEvent>>
> = {
  "foo.created": (_type, payload, meta) => {
    const parsed = fooCreatedPayloadSchema.parse(payload);
    return {
      ...meta,
      type: "foo.created",
      payload: { fooId: FooId.create(parsed.fooId) },
    };
  },
  "foo.deleted": (_type, payload, meta) => {
    const parsed = fooDeletedPayloadSchema.parse(payload);
    return {
      ...meta,
      type: "foo.deleted",
      payload: { fooId: FooId.create(parsed.fooId) },
    };
  },
};
```

ポイント:
- factory は `id` を引数で受ける（usecase が `container.idGenerator.next()` でミントして渡す）
- decoder map のキーは **完全な `event.type` 文字列**（`"foo.created"`）
- map 自体を `Record<FooEvent["type"], EventDecoder<FooEvent>>` で型付けして網羅性を強制
- 各 entry は throw する（relay worker が per-row catch してログに流す）
- payload schema は `z.object(...).strict()` で extra field を拒否
- ブランド型は decoder で `FooId.create(parsed.fooId)` を経由して再構築

### Repository Port

```ts
export interface FooRepository {
  findById(id: string): Promise<Foo | null>;
  findPage(pagination: Pagination): Promise<PaginationResult<Foo>>;
  save(foo: Foo): Promise<void>;                        // OCC: WHERE version = old
  delete(id: string, expectedVersion: number): Promise<void>;
}
```

lookup key は plain `string`。ブランドは adapter の `toFoo`（再水和）と event decoder
だけが付ける。application 層は VO を一度も構築しない。

新しいドメインを足すときは:

1. `UnitOfWorkContext` にスロットを 1 行追加（`app/core/application/execution/unitOfWork.ts`）
2. Drizzle adapter (`app/core/adapters/drizzleSqlite/unitOfWork.ts`) で tx 内に
   リポジトリインスタンスを生成し context に詰める

```ts
export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  fooRepository: FooRepository;          // ← 追加
  collectEvents(events: readonly DomainEvent[]): void;
}
```

## Application Layer

### Usecase

```ts
export async function createFoo({
  container,
  input,
}: ServiceArgs<CreateFooInput>): Promise<CreateFooOutput> {
  const now = container.clock.now();
  const id = container.idGenerator.next();
  const eventId = container.idGenerator.next();

  const { entity: foo, events } = Foo.create(
    { id, eventId, /* ...input fields... */ },
    now,
  );

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      await fooRepository.save(foo);
      collectEvents(events);
    },
  );

  return { foo: toFooView(foo) };
}
```

```ts
// 削除のように「後続エンティティが無い」操作は usecase で event を直接 emit する
export async function deleteFoo({
  container,
  input,
}: ServiceArgs<DeleteFooInput>): Promise<void> {
  const now = container.clock.now();
  const eventId = container.idGenerator.next();

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      const current = await fooRepository.findById(input.id);
      if (!current) throw new NotFoundError("FOO_NOT_FOUND", `...`);
      await fooRepository.delete(current.id, current.version);
      collectEvents([FooEvents.deleted(eventId, current.id, now)]);
    },
  );
}
```

ポイント:
- `now` / `id` / `eventId` を usecase 冒頭で resolve
- VO 生成点は entity factory / adapter 再水和 / event decoder の 3 箇所だけ
- `collectEvents` で Outbox パターンに乗せる（同一 tx で flush）
- 戻り値は DTO（`view.ts` 内の helper で射影）

OCC retry 用の汎用ユーティリティはあえて持たない。`ConflictError` は caller に
そのまま伝播し、必要な usecase だけが個別に retry を組む。

### Container 配線

```ts
export async function createContainer(config: ServerConfig): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider: new DrizzleSqliteUnitOfWorkProvider(db, SystemClock),
    outboxRepository: new DrizzleSqliteOutboxRepository(db),
    clock: SystemClock,
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}
```

env を読むパスは `readServerConfig()` に集約する。production 起動時は同じ
ファイル内で eager validate されるが、out-of-band な entry point（`seed.ts` など）
からも `readServerConfig()` を直接呼ぶ。

`SQLITE_BUSY` 等の transient lock contention は `DrizzleSqliteUnitOfWorkProvider` が
内部で retry する（driver-level concern なので application 層は触らない）。

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
      "OPTIMISTIC_LOCK_FAILURE",
      `Optimistic lock failure: ${foo.id}`,
    );
  }
}
```

ポイント:
- 0 件 update → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
- DB 例外は `mapDbError` で `SystemError(DatabaseError)` に変換
- upsert (`ON CONFLICT DO UPDATE`) は使わない（lost update を隠すため）

### Unit of Work

`app/core/adapters/drizzleSqlite/unitOfWork.ts` が `UnitOfWorkProvider.run(fn)` を実装する:

1. `db.transaction(...)` を開く
2. tx 内で repository / outbox インスタンスを構築し、`UnitOfWorkContext` に詰める
3. `collectEvents` のバッファを集めるコンテキストを fn に渡す
4. fn 解決後、collected events を outbox に save（同一 tx）

`SQLITE_BUSY` / `SQLITE_LOCKED` は driver-level の implementation detail なので、
adapter が `run()` 内部で exponential backoff retry する。application 層へ leak させない。

## Outbox Worker

```ts
import { processOutboxEvents } from "@/core/application/workers/eventRelayWorker";

await processOutboxEvents(container, async (event) => {
  // event.type で switch して下流ハンドラへ dispatch
}, { batchSize: 100 });
```

ポイント:
- 単一プロセス前提
- consumer は `event.id` ベースで冪等に書く（at-least-once delivery）
- decode / dispatch 失敗は logger に出して row を pending のまま残す

新しいドメインを足したら、その events ファイルから `<domain>EventDecoders` を export し、
`eventRelayWorker.ts` の `defaultEventDecoderRegistry` に spread で 1 行追加する：

```ts
export const defaultEventDecoderRegistry: EventDecoderRegistry = {
  ...todoEventDecoders,
  ...fooEventDecoders,        // ← 追加
};
```

### Outbox Prune

```ts
import { pruneOutbox } from "@/core/application/workers/outboxPrune";

await pruneOutbox(container, { retentionMs: 7 * 86_400_000 }); // 7 日保持
```

`retentionMs` は raw milliseconds。`pruneOutbox` は `clock.now() - retentionMs` を
cutoff にして `outboxRepository.pruneProcessed(cutoff)` を呼ぶ。pending な行
（`processed_at IS NULL`）には触らない。relay worker と並行して走らせて安全。

## エラー設計

| レイヤー | エラー型 | 置き場所 |
|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | `app/core/domain/error.ts` |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, `SystemError` | `app/core/application/errors/index.ts` |
| Presentation | `AppServerError` | `app/core/presentation/errorResponse.ts` |

すべてのエラークラスは `app/lib/error.ts` の抽象基底 `CodedError<TCode extends string>`
を継承する。基底クラスが `code: TCode` フィールド・デフォルトの `retryable: false` getter・
抽象メソッド `toSerialized()` を所有する。基底の戻り値型は構造的な
`SerializedErrorBase & { kind: string }` で、各サブクラスは override で自分の
`kind`-tagged variant に narrow する。

`code` は plain string。per-class enum はあえて畳んでいる（domain enum と
presentation で組み立てる `SerializedErrorKind` で必要な分類は揃う）。`SystemErrorCode` は
runtime の `retryable` 判定に使うので残してある。

`BusinessRuleError<TCode extends string = never>` のデフォルトは `never`。
未パラメータ化の `BusinessRuleError` を許すと catch 時に `code` が `string` まで
広がるので、throw 側でドメインの literal union を渡すことを強制している。
`isBusinessRuleError(...)` は `BusinessRuleError<string>` に narrow する。

各エラークラスは自分の `Serialized*Error` variant を同じファイルで宣言し
（`SerializedBusinessError` は domain、`SerializedNotFoundError` 等は application）、
`toSerialized()` でその variant を返す。presentation 層の `errorResponse.ts` が
全 variant を寄せ集めて `SerializedError` discriminated union を組み立てる。
新しいエラー型を足しても presentation の `serializeError` は触らなくて良い
（構造的に `toSerialized()` を呼ぶだけ）。`SerializedError` union と
`SerializedErrorKind` だけは presentation 層に追記する。
