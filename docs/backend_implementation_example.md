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
│       └── ports/${domain}Repository.ts   port インターフェース（UoW スロットは中央で enumerate）
├── application/
│   ├── di/server.ts               Container, createContainer, getContainer, readServerConfig
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── idGenerator.ts
│   │   ├── logger.ts
│   │   └── outboxRepository.ts    Outbox は application 層（infrastructural）
│   ├── errors/index.ts            NotFound / Conflict / Validation / ... + SystemError 再export
│   ├── execution/
│   │   ├── unitOfWork.ts          UnitOfWorkContext がリポジトリスロットを直接 enumerate
│   │   └── retry.ts
│   ├── workers/
│   │   ├── eventRelayWorker.ts
│   │   └── outboxPrune.ts         pruneOutbox(container, { retentionMs })
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
        ├── unitOfWork.ts          tx 内で各リポジトリを new して UoW context を組む
        ├── repositories/
        │   ├── helpers.ts         mapDbError
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/

app/lib/
├── error.ts                       AnyError, CodedError, formatErrorMessage
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

// 完全な event.type をキーにした per-event decoder map。
// `Record<FooEvent["type"], EventDecoder<FooEvent>>` で型付けすることで、
// union に variant を足したのに decoder を登録し忘れた場合は pnpm typecheck
// で落ちる（runtime に "no decoder" ログを出すのではなく compile-time error）。
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

// 単発呼び出し用の薄い dispatcher（テスト等で便利）。
// relay worker は map を直接 spread して使うのでこちらは経由しない。
export const decodeFooEvent: EventDecoder<FooEvent> = (type, payload, meta) => {
  const decoder = (
    fooEventDecoders as Record<string, EventDecoder<FooEvent>>
  )[type];
  if (!decoder) {
    throw new BusinessRuleError(FooErrorCode.UnknownEventType, `Unknown: ${type}`);
  }
  return decoder(type, payload, meta);
};
```

ポイント:
- factory は `id` を引数で受ける（usecase が `container.idGenerator.next()` でミントして渡す）
- decoder map のキーは **完全な `event.type` 文字列**（`"foo.created"`）。prefix-on-dot のような暗黙ルールは無い
- map 自体を `Record<FooEvent["type"], EventDecoder<FooEvent>>` で型付けして網羅性を強制
- 各 entry は throw する（relay worker が per-row catch してログに流す）
- payload schema は `z.object(...).strict()` で extra field を拒否
- ブランド型は decoder で `FooId.create(parsed.fooId)` を経由して再構築

### Repository Port

ポート定義は単独のインターフェースとして書く。`UnitOfWorkContext` への
スロット追加は中央 (`app/core/application/execution/unitOfWork.ts`) で
直接 enumerate する（declaration merging は使わない）。

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
```

新しいドメインを足すときは:

1. `UnitOfWorkContext` にスロットを 1 行追加する（`app/core/application/execution/unitOfWork.ts`）
2. Drizzle adapter (`app/core/adapters/drizzleSqlite/unitOfWork.ts`) で tx 内に
   リポジトリインスタンスを生成し context に詰める

```ts
// app/core/application/execution/unitOfWork.ts
export interface UnitOfWorkContext {
  todoRepository: TodoRepository;
  fooRepository: FooRepository;          // ← 追加
  collectEvents(events: readonly DomainEvent[]): void;
}
```

declaration merging を使わずに直接書くのは、テンプレートの規模では「中央 1 ファイル
+ adapter 配線」で十分明示的・読みやすく、IDE の "go to definition" で context 全体が
1 画面に映るほうが嬉しいから。`Pagination` / `PaginationResult` は
`app/core/domain/common/pagination.ts` の純粋型のみ（Zod schema は同居しない；
ランタイム検証はそれを消費する application 境界に inline する）。

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
2. tx 内で repository / outbox インスタンスを構築し、`UnitOfWorkContext` に詰める
3. `collectEvents` のバッファを集めるコンテキストを fn に渡す
4. fn 解決後、collected events を outbox に save（同一 tx）

新ドメインを足したときは、(a) 中央の `app/core/application/execution/unitOfWork.ts` で
`UnitOfWorkContext` にスロットを追加し、(b) この adapter ファイル内で対応する
リポジトリインスタンスを `runOnce` の中で `new` して context に詰める、の 2 箇所だけ。
declaration merging も side-effect import も不要。

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

新しいドメインを足したら、その events ファイルから `<domain>EventDecoders` を export し、
`eventRelayWorker.ts` の `defaultEventDecoderRegistry` に spread で 1 行追加する：

```ts
export const defaultEventDecoderRegistry: EventDecoderRegistry = {
  ...todoEventDecoders,
  ...fooEventDecoders,        // ← 追加
};
```

各 map の型 (`Record<DomainEvent["type"], EventDecoder<DomainEvent>>`) が
domain 単位で網羅性を担保しているので、spread で composing しても弱まらない。

### Outbox Prune

`processed_at IS NOT NULL` の行は audit/debug 用に残るので、運用では適宜削除する：

```ts
import { pruneOutbox } from "@/core/application/workers/outboxPrune";

await pruneOutbox(container, { retentionMs: 7 * 86_400_000 }); // 7 日保持
```

`retentionMs` は raw milliseconds（canonical unit）。`days * 86_400_000` のような
shorthand は call site で組む。`pruneOutbox` は `clock.now() - retentionMs` を
cutoff にして `outboxRepository.pruneProcessed(cutoff)` を呼ぶ。pending な行
（`processed_at IS NULL`）には触らない。relay worker と並行して走らせて安全
（`markProcessed` でスタンプされて初めて prune 候補になる）。

スケジュール（毎日 / 毎時）はテンプレートでは決め打ちしない — cron / queue worker
など環境のランナーに合わせて呼ぶ。

## エラー設計

| レイヤー | エラー型 | 置き場所 | 例 |
|---|---|---|---|
| Domain | `BusinessRuleError<FooErrorCode>` | `app/core/domain/error.ts` | 不正な title、未知の event type |
| Application | `NotFoundError`, `ConflictError`, `ValidationError`, ... | `app/core/application/errors/index.ts` | usecase ロジックで決まる失敗 |
| Cross-layer | `SystemError` | `app/lib/systemError.ts`（application 層から re-export） | DB / network / storage の低レベル失敗 |
| Adapter | 上記を throw | `mapDbError(...)` で wrap | OCC 失敗 → `ConflictError`、DB 例外 → `SystemError(DatabaseError)` |
| Presentation | `AppServerError` でラップして wire 化 | `app/core/presentation/errorResponse.ts` | `withErrorResponse` |

`SystemError` / `ApplicationError` / `BusinessRuleError` はいずれも
`app/lib/error.ts` の抽象基底 `CodedError<TCode extends string>` を継承する。
基底クラスが `code: TCode` フィールド・デフォルトの `retryable: false` getter・
抽象メソッド `toSerialized()` を所有し、各サブクラスは `retryable` を必要に
応じて override し、`toSerialized()` で `kind` discriminant を pin する。
基底を `app/lib/` に置いているのは、adapter / application / domain のどの層も
**上向き import 無しで** 同じ基底を継承できるようにするため（hexagonal:
adapter は domain port + 共通 lib にしか依存しない）。

`SystemError` だけ `app/lib/systemError.ts` に居るのも同じ理由で、application 層に
re-export があるので application 側の import パスは従来どおりで良い。

`BusinessRuleError<TCode extends string = never>` のデフォルトは `never`。
未パラメータ化の `BusinessRuleError` を許すと catch 時に `code` が `string` まで
広がってドメイン固有 union への narrowing が黙って消えるので、
`BusinessRuleError<TodoErrorCode>` のように throw 側でドメインの literal union を
渡すことを強制している。`isBusinessRuleError(...)` は `BusinessRuleError<string>` に
narrow するので、ドメインを問わない catch 句でも `error.code` は string として読める。

各エラークラスは `toSerialized(): SerializedError` を実装する（structural な `SerializableError` プロトコル）。新しいエラー型を足しても presentation の `serializeError` は触らなくて良い。
