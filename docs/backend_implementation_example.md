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
│       └── ports/${domain}Repository.ts   port + UoW augmentation (declare module)
├── application/
│   ├── di/server.ts               Container, createContainer, getContainer, readServerConfig
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── idGenerator.ts
│   │   ├── logger.ts
│   │   └── outboxRepository.ts    Outbox は application 層（infrastructural）
│   ├── errors/index.ts            NotFound / Conflict / Validation / ... + SystemError 再export
│   ├── execution/
│   │   ├── unitOfWork.ts          UnitOfWorkContext は { collectEvents } のみ宣言
│   │   └── retry.ts
│   ├── workers/eventRelayWorker.ts
│   ├── types.ts                   ServiceArgs<T>
│   └── ${domain}/
│       ├── view.ts                Aggregate → DTO 射影
│       ├── ${usecase}.ts          1 usecase 1 ファイル
│       └── __tests__/
├── presentation/
│   ├── errorResponse.ts           AppServerError, withErrorResponse, ...
│   ├── errorDisplay.ts            displayError, sanitizeRouteError
│   ├── useServerAction.ts
│   └── validator.ts               createValidator(schema)
└── adapters/
    └── drizzleSqlite/
        ├── client.ts
        ├── schema.ts
        ├── unitOfWork.ts          augmentation の side-effect import + repo 配線
        ├── repositories/
        │   ├── helpers.ts         mapDbError
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/

app/lib/
├── error.ts                       AnyError, formatErrorMessage
├── serializedError.ts             SerializedError 等の wire contract
└── systemError.ts                 SystemError（adapter から直接 import 可能な位置）
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
};
```

ポイント:
- `unique symbol` で nominal typing
- factory が唯一の作成経路（`as FooId` キャストは boundary でしか書かない）
- 不正値は `BusinessRuleError` を throw（Result 型は使わない）
- **`generate()` は置かない**。id 生成は ambient I/O（時計＋エントロピー依存）なので
  application 層の `IdGenerator` port 経由で行う。usecase が `container.idGenerator.next()`
  でフレッシュな string を取り、`FooId.create(...)` でブランドを付ける流れ。

### Entity（discriminated union + WithEvents）

```ts
// app/core/domain/${domain}/entity.ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (
    params: { id: FooId; eventId: string; /* ...domain inputs... */ },
    now: Date,
  ): WithEvents<ActiveFoo, FooEvent> => {
    const foo: ActiveFoo = { ...params, version: 0, createdAt: now, updatedAt: now };
    return { entity: foo, events: [FooEvents.created(params.eventId, foo.id, now)] };
  },

  complete: (foo: ActiveFoo, eventId: string, now: Date): WithEvents<CompletedFoo, FooEvent> => {
    const next: CompletedFoo = { ...foo, status: "completed", version: foo.version + 1, updatedAt: now };
    return { entity: next, events: [FooEvents.completed(eventId, next.id, now)] };
  },
};
```

ポイント:
- 状態を discriminated union で表現 → 不正な遷移は型エラー
- `now: Date` と必要な `id` / `eventId` を引数で受ける（domain は `new Date()` も `uuidv7()` も呼ばない）
- 状態遷移は `WithEvents<TEntity, TEvent>` を返してイベントとセットで扱う
- 削除のように **後続エンティティが無い操作は domain にメソッドを置かず、usecase が
  `FooEvents.deleted(...)` を直接 emit する**。`WithEvents<null, ...>` を返すだけの
  ドメインメソッドは儀式的になりやすい（`Todo.delete` を置かなくなったのと同じ理由）。
  必要なら別ドメインで `WithEvents<null, ...>` 自体は使ってよい。

### Domain Event

```ts
// app/core/domain/${domain}/events.ts
export type FooCreatedEvent = DomainEventBase<
  "foo.created",
  Readonly<{ fooId: FooId }>
>;

export type FooEvent = FooCreatedEvent | FooDeletedEvent;

export const FooEvents = {
  // factory は id と occurredAt を引数で受ける（domain は `uuidv7()` / `new Date()` を呼ばない）
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
- factory は `id` を引数で受ける（usecase が `container.idGenerator.next()` でミントして渡す）
- decoder は throw する（relay worker が per-row catch してログに流す）
- payload schema は `z.object(...).strict()` で extra field を拒否
- ブランド型は decoder で `FooId.create(parsed.fooId)` を経由して再構築

### Repository Port + UoW Augmentation

ポート定義と同じファイルで `UnitOfWorkContext` に declaration merging で
リポジトリのスロットを追加する。新しいドメインを足すときは自分のドメインフォルダに
閉じる（中央の `unitOfWork.ts` は触らなくて良い）。

```ts
// app/core/domain/${domain}/ports/${domain}Repository.ts
import type { Pagination, PaginationResult } from "@/core/domain/common/pagination";
import type { Foo } from "../entity";
import type { FooId } from "../valueObject";

export interface FooRepository {
  findById(id: FooId): Promise<Foo | null>;
  findPage(pagination: Pagination): Promise<PaginationResult<Foo>>;
  save(foo: Foo): Promise<void>;                   // OCC: WHERE version = old
  delete(id: FooId, expectedVersion: number): Promise<void>;
}

// declaration merging で UoW context を拡張する。adapter 側はこのファイルを
// side-effect import することで augmentation を読み込む。
declare module "@/core/application/execution/unitOfWork" {
  interface UnitOfWorkContext {
    fooRepository: FooRepository;
  }
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
  // ambient I/O は usecase 冒頭で 1 回だけ取って domain に渡す
  const now = container.clock.now();
  const id = FooId.create(container.idGenerator.next());
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
  const id = FooId.create(input.id);
  const now = container.clock.now();
  const eventId = container.idGenerator.next();

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      const current = await fooRepository.findById(id);
      if (!current) throw new NotFoundError(NotFoundErrorCode.FooNotFound, `...`);
      await fooRepository.delete(id, current.version);
      collectEvents([FooEvents.deleted(eventId, id, now)]);
    },
  );
}
```

ポイント:
- `now` / `id` / `eventId` を usecase 冒頭で resolve（domain は clock も id minter も触らない）
- `collectEvents` で Outbox パターンに乗せる（同一 tx で flush）
- 戻り値は DTO（`view.ts` 内の helper で射影）

冪等な「set X」系 usecase は `retry()` で OCC conflict を吸収する。
`now: Date` は **retry ループの外で** 1 回だけ取り、すべての試行が同じ瞬間に
合意する（OCC リトライで時刻がジッターしないように）。詳細は
`app/core/application/todo/changeTodoStatus.ts` 参照。リトライ枯渇時は元の
`ConflictError(OptimisticLockFailure)` がそのまま伝播する（再ラップしない）。

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
    idGenerator: UuidV7Generator,
    logger: ConsoleLogger,
  };
}
```

env を読むパスは `readServerConfig()` に集約する。production 起動時は同じ
ファイル内で eager validate されるが、out-of-band な entry point（`seed.ts` など）
からも `readServerConfig()` を直接呼ぶ。これで「seed と server で env デフォルトが
ズレる」という事故が起きない。

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

各ドメインの port ファイル（`app/core/domain/${domain}/ports/...`）に書いた
`declare module "@/core/application/execution/unitOfWork"` の augmentation を
読み込むため、adapter ファイル冒頭で **side-effect import** を入れる：

```ts
// app/core/adapters/drizzleSqlite/unitOfWork.ts
import "@/core/domain/todo/ports/todoRepository";
// ...新ドメインを足したら同じ場所に import を 1 行足す
```

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

| レイヤー | エラー型 | 置き場所 | 例 |
|---|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | `app/core/domain/error.ts` | 不正な title、未知の event type |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, ... | `app/core/application/errors/index.ts` | usecase ロジックで決まる失敗 |
| Cross-layer | `SystemError` | `app/lib/systemError.ts`（application 層から re-export） | DB / network / storage の低レベル失敗 |
| Adapter | 上記を throw | `mapDbError(...)` で wrap | OCC 失敗 → `ConflictError`、DB 例外 → `SystemError(DatabaseError)` |
| Presentation | `AppServerError` でラップして wire 化 | `app/core/presentation/errorResponse.ts` | `withErrorResponse` |

`SystemError` だけ `app/lib/` に置いてあるのは、adapter 層から
**application 層を上向きに import せずに** throw できるようにするため
（hexagonal: adapter は domain port + 共通 lib にしか依存しない）。
application 層には re-export があるので、application 側の import パスは
従来どおりで良い。

各エラークラスは `toSerialized(): SerializedError` を実装する（structural な `SerializableError` プロトコル）。新しいエラー型を足しても presentation の `serializeError` は触らなくて良い。
