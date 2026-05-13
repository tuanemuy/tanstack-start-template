# Backend Implementation Guide

Todo ドメインの実装が canonical example。新しいドメインを足すときも同じ構造をなぞれば良い。

> 原則 / 抽象概念は `CLAUDE.md` を参照。本ドキュメントは「具体的にどう書くか」の
> 写経用パターン集。

## ファイル配置

```
app/core/
├── domain/
│   ├── common/
│   │   ├── event.ts               DomainEventBase, EventDraft, EventDecoder, WithEventDrafts
│   │   └── pagination.ts
│   ├── error.ts                   BusinessRuleError
│   └── ${domain}/
│       ├── entity.ts
│       ├── valueObject.ts
│       ├── events.ts
│       ├── errorCode.ts
│       └── ports/${domain}Repository.ts
├── application/
│   ├── di/types.ts                SharedDeps, RequestContainer, WorkerContainer, AppConfig
│   ├── di/containerStore.ts       ContainerStore, installContainerStore, getInstalledStore, getContainer (shared)
│   ├── di/serverCloudflare.ts     createRequestContainer, createWorkerContainer, readRequestServerConfig (CF runtime)
│   ├── di/serverNode.ts           createNodeRequestContainer, createNodeWorkerContainer, readNodeServerEnv (Node runtime)
│   ├── ports/
│   │   ├── clock.ts
│   │   ├── idGenerator.ts
│   │   ├── logger.ts
│   │   └── outboxRepository.ts
│   ├── errors/index.ts            NotFound / Conflict / Validation / SystemError + helpers
│   ├── events/
│   │   └── buildDecoder.ts
│   ├── execution/unitOfWork.ts    UnitOfWorkContext がリポジトリスロットを直接 enumerate
│   ├── workers/
│   │   ├── eventRelayWorker.ts
│   │   └── outboxPrune.ts
│   ├── types.ts                   ServiceArgs<T>
│   └── ${domain}/
│       ├── view.ts
│       ├── eventDecoders.ts       outbox row → DomainEvent 再水和（SystemError に依存するため application 側）
│       ├── ${usecase}.ts
│       └── __tests__/
├── presentation/
│   ├── errorResponse.ts             AppServerError, serializeError, extractSerializedError, httpStatusFor
│   ├── errorResponseMiddleware.ts   errorResponseMiddleware (wraps inputValidator + handler)
│   ├── errorDisplay.ts            displayError, sanitizeRouteError
│   └── validator.ts               validateInput(schema) — transport-boundary shape check
└── adapters/
    └── d1/
        ├── client.ts
        ├── schema.ts              ドメインテーブル + `_occ_guard` (deferred-batch UoW の OCC abort用)
        ├── unitOfWork.ts          PendingBatch を組み立てて db.batch() で flush する D1UnitOfWorkProvider
        ├── pendingBatch.ts        Drizzle BatchItem buffer + OCC guard 自動付与
        ├── repositories/
        │   ├── helpers.ts         mapDbError + isOccGuardViolation
        │   ├── ${domain}Repository.ts
        │   └── outboxRepository.ts
        └── migrations/            wrangler が読む SQL マイグレーション

app/lib/
└── error.ts                       CodedError 基底 + SerializedErrorBase / FieldErrors / SerializableError interface（構造のみ。union は presentation で組立）
```

## Domain Layer

### Value Object

```ts
declare const fooIdBrand: unique symbol;
export type FooId = string & { readonly [fooIdBrand]: true };

export const FooId = {
  create: (id: string): FooId => {
    if (id.trim().length === 0) {
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
- domain は id を「不透明な非空文字列」として扱う。format（UUIDv7 / ULID / KSUID 等）は `IdGenerator` 実装の責務で、storage adapter が rehydration 時に `IdGenerator.validate(id)` で再検証する。生成と検証を同じ port にまとめることで、generator を差し替えたときに validator もペアで自動的に切り替わり、VO を触らずに format を入れ替えられる

### Entity

```ts
export type ActiveFoo = FooBase & Readonly<{ status: "active" }>;
export type CompletedFoo = FooBase & Readonly<{ status: "completed" }>;
export type Foo = ActiveFoo | CompletedFoo;

export const Foo = {
  create: (
    params: { id: string; /* ...domain inputs... */ },
    now: Date,
  ): WithEventDrafts<ActiveFoo, FooEvent> => {
    const id = FooId.create(params.id);
    const foo: ActiveFoo = { ...params, id, version: 0, createdAt: now, updatedAt: now };
    return { entity: foo, eventDrafts: [FooEvents.created(foo.id, now)] };
  },

  complete: (
    foo: ActiveFoo,
    now: Date,
  ): WithEventDrafts<CompletedFoo, FooEvent> => {
    const next: CompletedFoo = { ...foo, status: "completed", version: foo.version + 1, updatedAt: now };
    return { entity: next, eventDrafts: [FooEvents.completed(next.id, now)] };
  },
};
```

ポイント:
- 状態を discriminated union で表現 → 不正な遷移は型エラー
- `Todo.create` のように **VO 生成は entity factory に集約**（application 層は `id` を raw string で渡す）
- `now: Date` と必要な `id` を引数で受ける（domain は `new Date()` も `uuidv7()` も呼ばない）
- 状態遷移は `WithEventDrafts<TEntity, TEvent>` を返して **identity-less な draft** とセットで扱う。`EventId` の付与は application 層責務（`attachEventIds`）
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
  created: (fooId: FooId, occurredAt: Date): EventDraft<FooCreatedEvent> => ({
    type: "foo.created",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),

  deleted: (fooId: FooId, occurredAt: Date): EventDraft<FooDeletedEvent> => ({
    type: "foo.deleted",
    payload: { fooId },
    occurredAt,
    aggregateId: fooId,
  }),
};
```

ポイント:
- factory は **identity-less な draft** を返す。`EventId` の付与は **UoW 内部** で `idGenerator` 経由でミントされる（usecase は `collectEvents(drafts)` を呼ぶだけ）
- これによりドメイン関数の引数から `EventId` が消え、ID 生成責務は UoW adapter 一箇所に集約される
- domain には event 型と factory のみを置き、decoder は application 層へ（依存方向を inward に保つ）

#### Event Decoder（application 層）

decoder は `buildEventDecoder(type, schema, rehydrate)` ヘルパーで宣言的に書く。
schema 定義 + brand 再構築だけ書けば、shape assert / `SystemError` 変換 / meta 転送は
ヘルパーが吸収する。

```ts
// app/core/application/foo/eventDecoders.ts
import { z } from "zod";
import type { EventDecoder } from "@/core/domain/common/event";
import type { FooEvent } from "@/core/domain/foo/events";
import { FooId } from "@/core/domain/foo/valueObject";
import { buildEventDecoder } from "../events/buildDecoder";

const fooCreatedSchema = z.object({ fooId: z.string() }).strict();
const fooDeletedSchema = z.object({ fooId: z.string() }).strict();

export type FooEventDecoders = {
  readonly [K in FooEvent["type"]]: EventDecoder<
    Extract<FooEvent, { type: K }>
  >;
};

export const fooEventDecoders: FooEventDecoders = {
  "foo.created": buildEventDecoder("foo.created", fooCreatedSchema, (p) => ({
    fooId: FooId.create(p.fooId),
  })),
  "foo.deleted": buildEventDecoder("foo.deleted", fooDeletedSchema, (p) => ({
    fooId: FooId.create(p.fooId),
  })),
};
```

ポイント:
- decoder は **application 層** に置く。decode 失敗を `SystemError(DataIntegrityError)` に
  マップする以上、application のエラー契約に依存するため inward 方向の domain には置けない
- ドメイン追加時の差分は「schema 定義 + brand 再構築」だけ。shape assert / error 変換
  ロジックは `buildEventDecoder` に閉じ込める
- payload schema は `z.object(...).strict()` で extra field を拒否
- map 全体を `[K in FooEvent["type"]]: EventDecoder<Extract<...>>` で型付けして
  網羅性を強制（map に登録漏れがあると型エラー）
- ブランド型は `rehydrate` 関数内で `FooId.create(p.fooId)` を経由して再構築
- decode 失敗時は `SystemError(DataIntegrityError)` を throw（relay worker が
  per-row catch してログに流す）

### Repository Port

OCC を含む基本契約は `TransactionalRepository<TEntity, TId>` （`app/core/domain/common/transactionalRepository.ts`）
に集約済み。aggregate ごとの port はこれを継承し、読み取り専用クエリだけを足す:

```ts
export interface FooRepository extends TransactionalRepository<Foo> {
  findPage(pagination: Pagination): Promise<PaginationResult<Foo>>;
}
```

`TransactionalRepository<TEntity>` が提供するもの:

```ts
interface TransactionalRepository<TEntity, TId = string> {
  insert(entity: TEntity): Promise<void>;
  findById(id: TId): Promise<Versioned<TEntity> | null>;
  save(entity: TEntity, expectedVersion: ExpectedVersion<TEntity>): Promise<void>;
  delete(id: TId, expectedVersion: ExpectedVersion<TEntity>): Promise<void>;
}

type Versioned<T> = { readonly entity: T; readonly expectedVersion: ExpectedVersion<T> };
type ExpectedVersion<T> = number & { readonly [brand]: T };  // phantom T
```

lookup key は plain `string`。ブランドは adapter の `toFoo`（再水和）と event decoder
だけが付ける。application 層は VO を一度も構築しない。

OCC は `ExpectedVersion<Foo>` トークンで型強制する:

- `findById` だけが正規のトークン発行口（adapter 内部の `as` キャスト 1 か所）
- `save` / `delete` はトークンを必須引数で受ける → "読まずに書く" は型エラー
- `insert` は初回永続化専用。版が存在しないので OCC トークンは要らない
- `findPage` のような読み取り専用クエリは concrete port 側で別途定義

phantom `T` のおかげで `ExpectedVersion<Foo>` と `ExpectedVersion<Bar>` は型不一致 →
**aggregate 間でトークンを取り違えても型エラー**。「ドメイン関数が version を bump →
adapter で `entity.version - 1` を再計算」という implicit な接続を切り、読みの瞬間に
観測した版が write までそのまま運ばれる契約になる。

新しいドメインを足すときは:

1. `UnitOfWorkContext` にスロットを 1 行追加（`app/core/application/execution/unitOfWork.ts`）
2. D1 adapter (`app/core/adapters/d1/unitOfWork.ts`) で `PendingBatch` を共有しつつ
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

  const { entity: foo, eventDrafts } = Foo.create(
    { id, /* ...input fields... */ },
    now,
  );

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      await fooRepository.insert(foo);
      collectEvents(eventDrafts);
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

  await container.unitOfWorkProvider.run(
    async ({ fooRepository, collectEvents }) => {
      const found = await fooRepository.findById(input.id);
      if (!found) throw new NotFoundError("FOO_NOT_FOUND", `...`);
      await fooRepository.delete(found.entity.id, found.expectedVersion);
      collectEvents([FooEvents.deleted(found.entity.id, now)]);
    },
  );
}
```

ポイント:
- `now` / `id` を usecase 冒頭で resolve。`EventId` は **UoW が `collectEvents` 内部で** `idGenerator` 経由でミントするので、usecase は気にしなくていい
- VO 生成点は entity factory / adapter 再水和 / event decoder の 3 箇所だけ
- ドメイン関数は identity-less な draft を返し、`collectEvents(drafts)` でそのまま流すだけ。型引数の明示も不要
- `collectEvents` で Outbox パターンに乗せる（同一 tx で flush）
- 戻り値は DTO（`view.ts` 内の helper で射影）

OCC retry 用の汎用ユーティリティはあえて持たない。`ConflictError` は caller に
そのまま伝播し、必要な usecase だけが個別に retry を組む。

### Container 配線

Container は **scope ごとに独立した型** として 2 系統用意する。`SharedDeps`
（`clock` / `idGenerator` / `logger` / `shutdown`）を intersection で混ぜ込み、
それ以外のフィールドはその scope でしか必要にならないものだけを持つ。

```ts
export type SharedDeps = Readonly<{
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
  shutdown: () => Promise<void>;
}>;

// 集約変更を行う usecase / SSR head 用。`outboxRepository` は持たない
// (`collectEvents` 経由で UoW 内部から書く) し、`idempotencyStore` も持たない
// (queue consumer 専用)。
export type RequestContainer = SharedDeps &
  Readonly<{ config: AppConfig; unitOfWorkProvider: UnitOfWorkProvider }>;

// 直接 outbox を読み書きする relay / pruner / queue consumer / DLQ 用。
// `config` と `unitOfWorkProvider` は持たない。
export type WorkerContainer = SharedDeps &
  Readonly<{
    outboxRepository: OutboxRepository;
    idempotencyStore: IdempotencyStore;
  }>;
```

```ts
export function createRequestContainer(
  config: RequestServerConfig,
): RequestContainer { /* ...UoW + AppConfig... */ }

export function createWorkerContainer(env: ServerEnv): WorkerContainer {
  /* ...outboxRepository + idempotencyStore... */
}
```

`UnitOfWorkProvider` には `idGenerator` を渡す。これは `collectEvents` が
draft を outbox に flush する際に `EventId` をミントするのに使う。Container
本体の `idGenerator` と同じ instance を渡せば、テストで Fake に差し替えるとき
にも 1 箇所で済む。

request 側 env を読むパスは `readRequestServerConfig()` に集約する。worker は
`env: ServerEnv` をそのまま `createWorkerContainer` に渡せばよく、`AppConfig`
や `relay` Service Binding を経由しない（worker は HTML を返さず、relay を
キックする側でもないため）。

テスト用の `TestContainer = RequestContainer & WorkerContainer & { db }` は
両 scope のフィールドを 1 つの fat shape にしたもので、test 内で usecase 起動と
worker pipeline の検証を同居させるための便宜上の型。production code はこの
intersection を直接持たず、必ず `RequestContainer` / `WorkerContainer` の
どちらかを受け取る。

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

`app/core/adapters/d1/unitOfWork.ts` が `UnitOfWorkProvider.run(fn)` を実装する:

1. `PendingBatch` (Drizzle BatchItem buffer) を新規生成
2. repository / outbox インスタンスを共有 PendingBatch とともに構築し、`UnitOfWorkContext` に詰める
3. `collectEvents` のバッファを集めるコンテキストを fn に渡す
4. fn 解決後、collected events も同じ PendingBatch に積む
5. `db.batch(pending.build())` でアトミックに flush

D1 にはインタラクティブ tx が無いため、書き込みは UoW 内で都度実行されず PendingBatch
に蓄積される。読み取りは binding 直叩きで即時。OCC mismatch は `_occ_guard` テーブル
の CHECK 制約で batch 全体を abort させ、`ConflictError("OPTIMISTIC_LOCK_FAILURE")`
として presentation 層に届ける。

driver-level の transient エラーは Cloudflare の binding 側がハンドルするため
application-level retry は無い。

## Outbox Worker

```ts
import { processOutboxEvents } from "@/core/application/workers/eventRelayWorker";

await processOutboxEvents(container, async (event) => {
  // event.type で switch して下流ハンドラへ dispatch
}, { batchSize: 100 });
```

### Delivery contract（consumer 実装で守るべき落とし穴）

CLAUDE.md key concepts の通り、Outbox は **at-least-once delivery / ordering なし** で
動く。consumer はその前提で書く。原則の "なぜ" は CLAUDE.md、ここでは「実装で何を
守るべきか」を展開する。

- **At-least-once（同じ event が 2 回以上届く）** — relay worker は「dispatch 成功 →
  outbox 行の `processed_at` 更新」の順で動く。dispatch は通ったが update 直前で
  プロセスが落ちると同じ event が次のラウンドで再 dispatch される。consumer は
  `event.id` ベースの dedupe（処理済み id テーブル / unique index）か、natural key の
  upsert で **同じ event を N 回処理しても結果が変わらない** ように書く。「副作用を
  1 回だけ起こす」前提のコード（外部送信・課金・通知の "送りっぱなし"）はそのまま
  だと at-most-once が崩れた瞬間に重複する。
  - テンプレに同梱の `IdempotencyStore` ポート（`processed_events` テーブル + D1
    `INSERT OR IGNORE` で claim 化）が「処理済み id テーブル」の最小実装。`handleQueue`
    が `markProcessed(event.id)` を handler 実行前に呼び、`alreadyProcessed: true`
    なら handler を skip して ack。新しい consumer を書くときも同じパターンを踏襲する。
  - **Stamp first vs stamp inside handler** — テンプレ既定は stamp first（claim →
    handler → ack）。handler 側を「再実行しても結果が変わらない」上書き形（projection
    の UPSERT 等）に書けばこの順序で安全。逆に **副作用と stamp を一緒にロールバック
    したい**（外部送信・課金・通知の単発系）場合は handler を `UnitOfWorkProvider.run`
    で包み、その UoW 内で `markProcessed` と side-effect 書き込みを同一 batch にする。
- **Ordering なし（順序保証ゼロ）** — 各行は `next_attempt_at`（backoff + jitter で
  ばらける）と `attempts` の状態で個別に再スケジュールされるため、`foo.created` の
  前に `foo.updated` / `foo.deleted` が届く並びは普通に起こる。consumer 側で
  「`deleted` を見たら `created` も見ているはず」のような状態遷移を仮定したロジックは
  書かない。順序が必要なら **aggregate の現在状態を read してから判断する** か、
  event payload に必要な状態を全部載せて self-contained にする。
- **Quarantine（poison row 隔離）** — `attempts` が `maxAttempts`（デフォルト 2）に
  達した行は `failed_at` をセットしてクワランティン化される。partial index で
  `claimPending` から外れるので poison row が hot path をブロックしない。再キックは
  `failed_at` / `next_attempt_at` を NULL に戻して `attempts` を 0 リセット。
  decode 失敗（payload schema 不一致）も同じ retry path に乗る — schema 修正後に
  再キックして再 dispatch される。relay の `maxAttempts` × consumer の
  `1 + max_retries`（`wrangler.consumer.toml`）= ユーザーから見える総試行回数。
  小さい値同士の積で済ませるのが鉄則で、片方を 5 にすると相手が 5 でも 25 試行に膨らむ。
- **Multi-worker 安全性（claim/lease）** — 行は claim+select の 1 トランザクションで
  ロックされ、リース期間内は他 worker から不可視になる。worker クラッシュ時はリース
  満了で再 claim 可能。複数 worker を起動しても同一行が二重 dispatch されない。

### ポイント

- decode / dispatch 失敗は logger に出して `attempts++` + exponential backoff で
  `next_attempt_at` を再スケジュール

新しいドメインを足したら、`app/core/application/${domain}/eventDecoders.ts` から
`<domain>EventDecoders` を export し、`eventRelayWorker.ts` の
`AllDomainEvents` 型ユニオンと `defaultEventDecoderRegistry` の双方に追加する：

```ts
type AllDomainEvents = TodoEvent | FooEvent;        // ← union を拡張

export const defaultEventDecoderRegistry = {
  ...todoEventDecoders,
  ...fooEventDecoders,        // ← decoder を追加
} satisfies DefaultEventDecoderRegistry;
```

`DefaultEventDecoderRegistry` は `AllDomainEvents` から派生する完全マップ型で、
`satisfies` がドメインを足し忘れたまま decoder だけ書いた／その逆をコンパイルエラーで
弾く。`EventDecoderRegistry`（`Partial<DefaultEventDecoderRegistry>`）はテスト等で
override を渡す際の型で、未知の event type を構文レベルで禁止する。

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
