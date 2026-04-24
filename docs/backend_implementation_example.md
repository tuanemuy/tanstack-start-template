# Backend Implementation Example

ドメイン層・アダプタ層・アプリケーション層は TanStack Start (RSC) と
直接結びつかない、フレームワーク非依存の純粋な TypeScript で書く。
プレゼンテーション層（loader / `createServerFn` / コンポーネント）の例は
`docs/frontend_implementation_example.md` を参照。


## Entities example

```typescript
// app/core/domain/post/entity.ts

import type { WithEvents } from "@/core/domain/common/event";
import type { UserId } from "@/core/domain/user/valueObject";
import { PostEvents, type PostEvent } from "./events";
import { PostContent, PostId } from "./valueObject";

type PostBase = Readonly<{
  id: PostId;
  userId: UserId;
  content: PostContent;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;

type DraftPost = PostBase & { readonly status: "draft" };
type PublishedPost = PostBase & { readonly status: "published" };

type Post = DraftPost | PublishedPost;

export type { DraftPost, Post, PublishedPost };

// 状態遷移を保つ振る舞いは discriminated union の variant を引数で受け取る
// 関数として `const Post = { ... }` の外に書く。`publish` の引数は
// `DraftPost` に限定されるので "公開済みを再度 publish" はコンパイルエラー
// になり、illegal state の多くを型で弾ける。
//
// `now: Date` を **必須引数** で受け取るのがテンプレ規約。ドメインは
// `new Date()` を直接呼ばない — 時刻の解決は `Clock` ポートを持っている
// アプリケーション層の責務にして、ドメイン側はピュアな関数として保つ。
// テストでは固定 Date を流し込めば `updatedAt` も `occurredAt` も決定論的に
// 検証できる。
function publish(
  post: DraftPost,
  now: Date,
): WithEvents<PublishedPost, PostEvent> {
  const next: PublishedPost = {
    ...post,
    status: "published",
    version: post.version + 1,
    updatedAt: now,
  };
  return {
    entity: next,
    // イベントの occurredAt も同じ Date を使い、エンティティの updatedAt と
    // 「同じ瞬間に起きた」ことを構造的に保証する。
    events: [PostEvents.published(next.id, now)],
  };
}

export const Post = {
  isDraft: (post: Post): post is DraftPost => post.status === "draft",
  isPublished: (post: Post): post is PublishedPost =>
    post.status === "published",

  /**
   * 新規 Post を作成する。`version` は 0 始まり。
   * 戻り値は `WithEvents` で包み、呼び出し側が `collectEvents` で
   * outbox に流し込むことを強制する。
   *
   * `now` は createdAt / updatedAt / 発火イベントの occurredAt のすべてに
   * 使われるので、集約とその初手イベントは構造的に同一瞬間を共有する。
   */
  create: (
    params: { userId: UserId; content: string },
    now: Date,
  ): WithEvents<DraftPost, PostEvent> => {
    const post: DraftPost = {
      id: PostId.generate(),
      userId: params.userId,
      content: PostContent.create(params.content),
      status: "draft",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return {
      entity: post,
      events: [PostEvents.created(post.id, params.userId, now)],
    };
  },

  publish,

  /**
   * 削除は terminal な操作で後続エンティティが存在しない。それでも戻り値は
   * `WithEvents<null, PostEvent>` に統一し、`entity: null` で「集約は消えた」
   * ことを表しつつ、emit されたイベントは他の操作と同じ `collectEvents`
   * 経路に流す。成功呼び出し・失敗呼び出しで結果の形が揃うので、ユースケース
   * 側のコードパスが分岐しない。
   */
  delete: (post: Post, now: Date): WithEvents<null, PostEvent> => ({
    entity: null,
    events: [PostEvents.deleted(post.id, now)],
  }),
};
```

`Post.fromPersistence` のような「DB 行 → エンティティ」を担うスタティック
メソッドは **定義しない**。再ハイドレーションはアダプタ内部の private な
`rowToPost` に閉じ込める（後述）。ドメイン層は永続化スキーマを知らずに
済む。

## Value Objects example

branded 型は `unique symbol` による nominal brand を採用する。`declare const
xxxBrand: unique symbol` をモジュール内に宣言し、`type PostId = string & {
readonly [postIdBrand]: true }` で付ける。symbol キーは外部モジュールから通常の
構造的代入では再構成できないので、`PostId.create` / `PostId.generate` が
この brand を手に入れる唯一の正規経路になる。ただし TypeScript の
`value as PostId` は checker を迂回できるため、外部入力・DB・JSON 境界では
必ず factory を再実行する。

```typescript
// app/core/domain/post/valueObject.ts

import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { BusinessRuleError } from "@/core/domain/error";
import { PostErrorCode } from "./errorCode";

const POST_CONTENT_MAX_LENGTH = 5000;

// 外部から再構成不能な nominal brand。
declare const postIdBrand: unique symbol;
declare const postContentBrand: unique symbol;

export type PostId = string & { readonly [postIdBrand]: true };

export const PostId = {
  create: (id: string): PostId => {
    // 入力が UUIDv7 等の期待 shape かどうかをここで検証する。
    // 例: if (!UUID_V7_PATTERN.test(id)) throw new BusinessRuleError(...);
    return id as PostId;
  },
  /**
   * サーバーサイドで UUIDv7 を発行する。集約 id はクライアント入力から
   * 受け取らず必ずドメインが mint する前提で、monotonic な時刻順序を
   * 保証するために UUIDv7 を使っている。テスト用に決定論的 id が
   * 欲しくなったら Port 化ではなくラッパ関数を被せる（YAGNI）。
   */
  generate: (): PostId => uuidv7() as PostId,
};

// zod の schema を公開しておくと、server function 側の inputValidator や
// Conform の constraint にそのまま流用できる。schema 出力は plain string で、
// brand を付けるのは `PostContent.create` を介する経路のみ — 「brand を持って
// いる = create を通った」を単一の真実の源として維持するため。
const postContentSchema = z.string().trim().min(1).max(POST_CONTENT_MAX_LENGTH);

export type PostContent = string & { readonly [postContentBrand]: true };

export const PostContent = {
  schema: postContentSchema,
  maxLength: POST_CONTENT_MAX_LENGTH,
  create: (raw: string): PostContent => {
    const result = postContentSchema.safeParse(raw);
    if (result.success) return result.data as PostContent;
    const issue = result.error.issues[0];
    const code =
      issue?.code === "too_big"
        ? PostErrorCode.ContentTooLong
        : PostErrorCode.ContentEmpty;
    throw new BusinessRuleError(code, "Invalid post content", result.error);
  },
};
```

## Domain Events example

イベントの payload は **wire 型**（JSON シリアライズ後のフラットな形）と
**decoded 型**（value object 入りのドメイン表現）の 2 種類を明示的に分けて
宣言する。ドメイン内で新しく emit するイベントは decoded 型を持つが、outbox
を経由すると branded 値オブジェクトは単なる string に畳まれるため、戻ってきた
payload は decode 関数で value object を再構築してから consumer に渡す。

`DomainEventBase` には `schemaVersion: number` と `aggregateId: string` が
**両方とも必須**で乗っている。各ドメインは自前の `*_EVENT_SCHEMA_VERSION`
定数を定義し、イベントファクトリが必ずスタンプする。outbox アダプタは
`event.schemaVersion` / `event.aggregateId` をそのまま列に書き込むだけで、
ドメイン横断の "type → version" マッピングや「集約 id 逆引き」を持つ必要が
ない。

decode 関数は `EventDecodeResult<TEvent>`
（`{ ok: true; event } | { ok: false; error }`）を返す Result 型シグネチャ。
**throw しない**のは、1 件壊れた outbox 行が relay バッチ全体を巻き戻す事故
を防ぐため。value object ファクトリが投げた `BusinessRuleError` も decode
関数側で catch して `error` チャネルに畳み込む。worker はこの `ok` を分岐
して decode 失敗を skip + observability 信号に回し、残りのバッチを進める。

```typescript
// app/core/domain/post/events.ts

import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type {
  DomainEventBase,
  EventDecodeMeta,
  EventDecodeResult,
  EventDecoder,
} from "@/core/domain/common/event";
import { BusinessRuleError } from "@/core/domain/error";
import type { UserId } from "@/core/domain/user/valueObject";
import { PostErrorCode } from "./errorCode";
import { PostId } from "./valueObject";

/**
 * このモジュールが encode/decode できる wire 上のスキーマバージョン。
 * payload の形を変えるときは値を bump し、decodePostEvent に旧バージョン
 * 向けの分岐を追加して既存の outbox 行を壊さないようにする。
 */
export const POST_EVENT_SCHEMA_VERSION = 1 as const;

const postCreatedPayloadSchema = z
  .object({ postId: z.string(), userId: z.string() })
  .strict();
const postPublishedPayloadSchema = z.object({ postId: z.string() }).strict();
const postDeletedPayloadSchema = z.object({ postId: z.string() }).strict();

// --- wire payloads (outbox 行から読み戻した直後の形) ------------------
// branded 型は serialize 時に string に畳まれるので、wire 側は string で
// 宣言する。`decodePostEvent` が唯一の wire → domain の公式経路。
export type PostCreatedEventPayload = Readonly<{
  postId: string;
  userId: string;
}>;
export type PostPublishedEventPayload = Readonly<{ postId: string }>;
export type PostDeletedEventPayload = Readonly<{ postId: string }>;

// --- decoded payloads (consumer に渡す形) ------------------------------
// value object ファクトリを通した後に consumer が見る型。ドメイン内で
// 新しく emit する `TodoEvents.created(...)` はこちら側の payload を持つ。
export type PostCreatedEventPayloadDecoded = Readonly<{
  postId: PostId;
  userId: UserId;
}>;
export type PostPublishedEventPayloadDecoded = Readonly<{ postId: PostId }>;
export type PostDeletedEventPayloadDecoded = Readonly<{ postId: PostId }>;

export type PostCreatedEvent = DomainEventBase<
  "post.created",
  PostCreatedEventPayloadDecoded
>;
export type PostPublishedEvent = DomainEventBase<
  "post.published",
  PostPublishedEventPayloadDecoded
>;
export type PostDeletedEvent = DomainEventBase<
  "post.deleted",
  PostDeletedEventPayloadDecoded
>;

export type PostEvent =
  | PostCreatedEvent
  | PostPublishedEvent
  | PostDeletedEvent;

// イベントファクトリも `occurredAt: Date` を必須引数で受け取る。`new Date()`
// を内部で呼ばないのは、エンティティの `updatedAt` と発火イベントの
// `occurredAt` を同じ瞬間で揃える呼び出し規約をドメイン側で強制するため。
// 上の `Post.publish(post, now)` のように、呼び出し元が同じ `now` を両方に
// 流し込むことで「いつ起きたか」がアプリ全体で一貫する。
export const PostEvents = {
  created: (
    postId: PostId,
    userId: UserId,
    occurredAt: Date,
  ): PostCreatedEvent => ({
    id: uuidv7(),
    type: "post.created",
    payload: { postId, userId },
    occurredAt,
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),

  published: (postId: PostId, occurredAt: Date): PostPublishedEvent => ({
    id: uuidv7(),
    type: "post.published",
    payload: { postId },
    occurredAt,
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),

  deleted: (postId: PostId, occurredAt: Date): PostDeletedEvent => ({
    id: uuidv7(),
    type: "post.deleted",
    payload: { postId },
    occurredAt,
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),
};

/**
 * 永続化境界で読んだ payload を typed な PostEvent に戻す。Result 型を返す。
 *
 * - schemaVersion が未対応なら `{ ok: false, error }` で返す（旧版対応を
 *   追加するときはここで分岐を増やし、既存の outbox 行を壊さない）。
 * - value object ファクトリが投げた `BusinessRuleError` は try/catch で
 *   受け止めて `error` チャネルに畳み込む。worker が一様に `ok` で分岐する
 *   ため、throw は禁止。
 */
export const decodePostEvent: EventDecoder<PostEvent> = (
  type: string,
  payload: Record<string, unknown>,
  meta: EventDecodeMeta,
): EventDecodeResult<PostEvent> => {
  if (meta.schemaVersion !== POST_EVENT_SCHEMA_VERSION) {
    return {
      ok: false,
      error: new BusinessRuleError(
        PostErrorCode.UnsupportedEventSchema,
        `Unsupported post event schema version: ${meta.schemaVersion}`,
      ),
    };
  }
  try {
    const base = {
      id: meta.id,
      occurredAt: meta.occurredAt,
      schemaVersion: meta.schemaVersion,
      aggregateId: meta.aggregateId,
    };
    switch (type) {
      case "post.created": {
        const parsed = postCreatedPayloadSchema.parse(payload);
        const postId = PostId.create(parsed.postId);
        // userId を含む type の分岐で value object を組み直す
        // case "post.published": / case "post.deleted":
        //   value object を組み直して `{ ok: true, event }` を返す
      }
      case "post.published": {
        const parsed = postPublishedPayloadSchema.parse(payload);
        const postId = PostId.create(parsed.postId);
        // `{ ok: true, event }` を返す
      }
      case "post.deleted": {
        const parsed = postDeletedPayloadSchema.parse(payload);
        const postId = PostId.create(parsed.postId);
        // `{ ok: true, event }` を返す
      }
      default:
        return {
          ok: false,
          error: new BusinessRuleError(
            PostErrorCode.UnknownEventType,
            `Unknown post event type: ${type}`,
          ),
        };
    }
  } catch (error) {
    if (error instanceof BusinessRuleError) {
      return { ok: false, error };
    }
    return {
      ok: false,
      error: new BusinessRuleError(
        PostErrorCode.EventDecodeFailed,
        "Failed to decode post event payload",
        error,
      ),
    };
  }
};
```

### Schema version を bump するときの手順

1. `POST_EVENT_SCHEMA_VERSION` の値を incrment する（`1` → `2` など）。
2. `decodePostEvent` 内の `meta.schemaVersion` 比較を旧版も受けるように
   分岐し、旧バージョン向けの payload shape を読む経路を追加する。新 shape
   は通常経路で処理し、既存 outbox 行（旧 shape + 旧 version）はそこで
   互換 decode する。
3. fake / integration テストに旧バージョン行を入れたフィクスチャを追加し、
   `decode` が `{ ok: true, event }` で返ること、互換経路が退化していない
   ことを確認する。

## Ports example

Read-only なユースケース（list / get 系）と read/write なユースケースで
呼べるメソッドを型で分けるため、port は `*Reader` と `*Repository` の
二段構成にする。`*Repository` は `*Reader` を継承して save/delete を追加
する。

`delete` は `expectedVersion` を引数に取る。アダプタ側は
`WHERE id = ? AND version = expectedVersion` でスコープし、0 行だったら
`ConflictError(OptimisticLockFailure)` を投げる。こうすると
"削除しようとしたら別 writer が先に更新していた" が黙って失われず、
ユースケース側で検知できる。

```typescript
// app/core/domain/post/ports/postRepository.ts

import type { Pagination, PaginationResult } from "@/core/domain/common/pagination";
import type { Post } from "@/core/domain/post/entity";
import type { PostId } from "@/core/domain/post/valueObject";
import type { UserId } from "@/core/domain/user/valueObject";

export interface PostReader {
  findById(id: PostId): Promise<Post | null>;
  findByUserId(userId: UserId, pagination: Pagination): Promise<PaginationResult<Post>>;
}

export interface PostRepository extends PostReader {
  save(post: Post): Promise<void>;
  // OCC guard: 呼び出し元が握っている version を渡し、アダプタが
  // `WHERE version = expectedVersion` で scope して 0 行なら
  // `ConflictError(OptimisticLockFailure)` を投げる。
  delete(id: PostId, expectedVersion: number): Promise<void>;
}
```

Outbox はユースケース向けとワーカー向けで port を **明示的に分割** する：

```typescript
// app/core/domain/common/ports/outboxRepository.ts (抜粋)

/** ユースケースが持つ唯一の書き込み面。collectEvents 経由で間接呼び出し。 */
export interface OutboxWriter {
  saveEvents(events: readonly DomainEvent[]): Promise<void>;
}

/** 拡張点。現状はマーカー interface。 */
export interface OutboxReader {}

/** 未処理行の claim + 処理完了マーク。relay worker 専用。 */
export interface OutboxWorkerRepository extends OutboxReader {
  claimPending(
    batchSize: number,
    leaseDurationMs: number,
    now: Date,
  ): Promise<OutboxClaimBatch>;
  markProcessed(
    handle: OutboxClaimHandle,
    ids: readonly string[],
  ): Promise<void>;
}

/**
 * `claimPending` の戻り値。`handle` はアダプタ内部の記録（lease token など）
 * を wrap した opaque なブランド型で、`markProcessed` に verbatim 渡すだけ。
 * ドメイン port 表面に `leaseToken: string` は現れない。
 */
export type OutboxClaimBatch = Readonly<{
  entries: readonly ClaimedOutboxEntry[];
  handle: OutboxClaimHandle;
}>;
```

`OutboxWriter` は usecase 側から **直接は呼ばない** — `collectEvents` だけを
経由する。DI コンテナから `outboxWriter` を直接渡せないようにすることで
「2 系統の書き込み経路」が存在しない状態を型で固定する。`OutboxWorkerRepository`
は `WorkerContext` 経由で relay worker にのみ露出する。

イベントの配送順序は `occurredAt` ではなく、outbox writer が同一 transaction
内で採番する `outbox_events.sequence` によって決める。複数イベントが同一時刻
に作られても、`collectEvents([a, b, c])` の順序で永続化・claim される。

## Adapters example

アダプタは reader クラスと repository クラスの 2 種類を export し、
repository は reader を `extends` する。UoW は `runReadonly` のとき reader を、
`runReadWrite` のとき repository をインスタンス化して context に組み立てる。
`runWorker` は outbox の worker repository だけを組み立てて `WorkerContext`
を返す。

DB 行からエンティティに戻す責任はアダプタ内部の private な `rowToPost` に
閉じ込める。VO ファクトリ（`PostId.create` / `PostContent.create` …）を
逐次呼び出し、`BusinessRuleError` が飛んだら「保存済みデータが不変条件を
破っている」という infrastructural な破損として `SystemError(DatabaseError)`
に畳んで上位に伝える。ドメイン層は永続化スキーマを一切知らない。

```typescript
// app/core/adapters/drizzleSqlite/repositories/postRepository.ts

import { and, desc, eq, sql } from "drizzle-orm";
import {
  ConflictError,
  ConflictErrorCode,
  SystemError,
  SystemErrorCode,
} from "@/core/application/errors";
import type { Pagination, PaginationResult } from "@/core/domain/common/pagination";
import { BusinessRuleError } from "@/core/domain/error";
import type { DraftPost, Post, PublishedPost } from "@/core/domain/post/entity";
import type { PostReader, PostRepository } from "@/core/domain/post/ports/postRepository";
import { PostContent, PostId } from "@/core/domain/post/valueObject";
import type { UserId } from "@/core/domain/user/valueObject";
import type { Executor } from "../client";
import { posts } from "../schema";
import { mapDbError } from "./helpers";

type PostRow = typeof posts.$inferSelect;

/**
 * DB 行 → Post aggregate の再ハイドレーション。
 *
 * 各列を VO ファクトリに通して不変条件を再検証し、フラットな `status`
 * 列を `draft | published` の discriminated union に持ち上げる。
 *
 * VO ファクトリから `BusinessRuleError` が飛んだ場合は「保存済みデータが
 * 破損している」という infrastructural な失敗とみなし、`SystemError
 * (DatabaseError)` に畳み直す（`cause` は温存）。
 */
function rowToPost(row: PostRow): Post {
  try {
    if (!Number.isInteger(row.version) || row.version < 0) {
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        `Stored post has invalid version: ${row.version}`,
      );
    }
    const base = {
      id: PostId.create(row.id),
      userId: row.userId as UserId,
      content: PostContent.create(row.content),
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return row.status === "published"
      ? ({ ...base, status: "published" } satisfies PublishedPost)
      : ({ ...base, status: "draft" } satisfies DraftPost);
  } catch (error) {
    if (error instanceof BusinessRuleError) {
      throw new SystemError(
        SystemErrorCode.DatabaseError,
        "Stored post violates invariants",
        error,
      );
    }
    throw error;
  }
}

export class DrizzlePostReader implements PostReader {
  constructor(protected readonly executor: Executor) {}

  findById(id: PostId): Promise<Post | null> {
    return mapDbError("Failed to find post", async () => {
      const rows = await this.executor.select().from(posts).where(eq(posts.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToPost(row) : null;
    });
  }

  findByUserId(userId: UserId, pagination: Pagination): Promise<PaginationResult<Post>> {
    return mapDbError("Failed to find posts", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      // SQLite は 1 本のコネクションで serialize されるし、libsql ドライバの
      // バージョンによっては同一 executor への同時発行で fault するので、
      // Promise.all ではなく逐次 await する。
      const items = await this.executor
        .select()
        .from(posts)
        .where(eq(posts.userId, userId))
        .orderBy(desc(posts.createdAt))
        .limit(pagination.limit)
        .offset(offset);
      const countRows = await this.executor
        .select({ count: sql<number>`count(*)` })
        .from(posts)
        .where(eq(posts.userId, userId));
      return {
        items: items.map(rowToPost),
        count: Number(countRows[0]?.count ?? 0),
      };
    });
  }
}

export class DrizzlePostRepository extends DrizzlePostReader implements PostRepository {
  async save(post: Post): Promise<void> {
    if (post.version === 0) {
      await mapDbError("Failed to insert post", async () => {
        await this.executor.insert(posts).values({
          id: post.id,
          userId: post.userId,
          content: post.content,
          status: post.status,
          version: post.version,
          createdAt: post.createdAt,
          updatedAt: post.updatedAt,
        });
      });
      return;
    }
    // version > 0 → optimistic-lock-guarded UPDATE。
    // ON CONFLICT DO UPDATE (upsert) は lost update を隠すので使わない。
    const previousVersion = post.version - 1;
    const updated = await mapDbError("Failed to update post", () =>
      this.executor
        .update(posts)
        .set({
          content: post.content,
          status: post.status,
          version: post.version,
          updatedAt: post.updatedAt,
        })
        .where(and(eq(posts.id, post.id), eq(posts.version, previousVersion)))
        .returning({ id: posts.id }),
    );
    if (updated.length === 0) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while saving post ${post.id}: expected version ${previousVersion}`,
      );
    }
  }

  async delete(id: PostId, expectedVersion: number): Promise<void> {
    const deleted = await mapDbError("Failed to delete post", () =>
      this.executor
        .delete(posts)
        .where(and(eq(posts.id, id), eq(posts.version, expectedVersion)))
        .returning({ id: posts.id }),
    );
    if (deleted.length === 0) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while deleting post ${id}: expected version ${expectedVersion}`,
      );
    }
  }
}
```

`mapDbError` は `app/core/adapters/drizzleSqlite/repositories/helpers.ts`
に置いてある唯一の共通ヘルパー。DB から飛んできた例外を
`SystemError(DatabaseError)` に畳み直し、`ConflictError` など既に
application-level の型で投げられたエラーはそのまま通す。

## Database schema example

```typescript
// app/core/adapters/drizzleSqlite/schema.ts

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    // Other fields...
    version: integer("version").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
);
```

`updatedAt` は `$onUpdate` を使わず、ドメイン層（エンティティの `create` /
振る舞いメソッド）で付け替える。永続化層は渡された値をそのまま書き込み、
時刻はドメインが単一の真実の源として管理する。

## Application Service DTO example

```typescript
// app/core/application/post/dto.ts

export type PostDetail = {
  id: string;
  title: string;
  content: string;
  authorName: string;
  createdAt: Date;
};
```

## Application Service example

ユースケースは `ServiceArgs<TInput>` か `AuthedServiceArgs<TInput>` を受け取り、
`{ container, (headers,) input }` の形で呼び出される。
`headers` は loader / server function から
`@tanstack/react-start/server` の `getRequestHeaders()` 経由で渡す。

認証・ユーザー文脈が必要ない集計や一覧系は `ServiceArgs`、認証／監査が必要な
操作は `AuthedServiceArgs` を選ぶ。

```typescript
// app/core/application/post/createPost.ts

import { Post } from "@/core/domain/post/entity";
import { UnauthenticatedError, UnauthenticatedErrorCode } from "../errors";
import type { AuthedServiceArgs } from "../types";
import type { PostDetail } from "./dto";

export type CreatePostInput = { content: string };
export type CreatePostOutput = { post: PostDetail };

export async function createPost({
  container,
  headers,
  input,
}: AuthedServiceArgs<CreatePostInput>): Promise<CreatePostOutput> {
  const currentUser = await container.authProvider.getCurrentUser(headers);
  if (!currentUser) {
    throw new UnauthenticatedError(
      UnauthenticatedErrorCode.AuthenticationRequired,
      "Authentication required",
    );
  }

  // 「今」をユースケースの入口で 1 回だけ Clock ポートから引き、ドメイン
  // 操作には引数として渡す。同じ Date を `Post.create` も `PostEvents.*` も
  // 共有するので「集約が作られた瞬間」と「created イベントの occurredAt」が
  // 構造的に同期する。テストでは container.clock を FakeClock に差し替えれば
  // 決定論的に検証できる。
  const now = container.clock.now();
  const { entity: post, events } = Post.create(
    { userId: currentUser.id, content: input.content },
    now,
  );

  // Outbox パターン: エンティティ変更とイベント保存を同一トランザクションで
  // 実行。`collectEvents` で受け取ったイベントは runReadWrite() が終わる直前に
  // outbox へ flush される。`OutboxWriter` / `OutboxWorkerRepository` は
  // `ReadWriteContext` に入っていないので、ユースケースから直接 saveEvents
  // / claim を呼ぶことはできない。
  await container.unitOfWorkProvider.runReadWrite(
    async ({ postRepository, collectEvents }) => {
      await postRepository.save(post);
      collectEvents(events);
    },
  );

  // 実際の dispatch は別プロセスの EventRelayWorker が outbox を drain して行う。
  return {
    post: {
      id: post.id,
      title: post.title,
      content: post.content,
      authorName: currentUser.name,
      createdAt: post.createdAt,
    },
  };
}
```

削除のユースケースでは `Post.delete` が返す `WithEvents<null, …>` から
`events` を取り出し、`collectEvents` へ流す：

```typescript
// app/core/application/post/deletePost.ts (抜粋)

const now = container.clock.now();
await container.unitOfWorkProvider.runReadWrite(
  async ({ postRepository, collectEvents }) => {
    const current = await postRepository.findById(input.postId);
    if (!current) throw new NotFoundError(NotFoundErrorCode.PostNotFound, "...");
    // 削除も WithEvents 統一。entity: null は「集約は消えた」を表す。
    const { events } = Post.delete(current, now);
    // 読み取った version を渡して `WHERE id = ? AND version = ?` で scope。
    // 並行 writer が先に version を進めていれば OptimisticLockFailure。
    await postRepository.delete(current.id, current.version);
    collectEvents(events);
  },
);
```

### 冪等 no-op: events.length === 0 なら save/collectEvents を呼ばない

`rename` のようにドメインが「変更なし」を判定するケースでは、
`WithEvents.events` が空になる。このとき **save も collectEvents も呼ばない**
のがテンプレの基本パターン：

```typescript
const now = container.clock.now();
await container.unitOfWorkProvider.runReadWrite(
  async ({ postRepository, collectEvents }) => {
    const current = await postRepository.findById(input.postId);
    if (!current) throw new NotFoundError(...);
    const { entity: next, events } = Post.rename(current, input.title, now);
    if (events.length === 0) {
      // 同じタイトルへの再送などで idempotent 判定された。save を呼ぶと
      // 無駄な updatedAt churn と version bump、空の outbox 行を生む。
      return;
    }
    await postRepository.save(next);
    collectEvents(events);
  },
);
```

### read-only mode

副作用を持たない参照系ユースケースは `runReadonly(fn)` で
`ReadonlyContext` を受け取る。`postRepository: PostReader` に narrow されて
いるので、`save` / `delete` は **コンパイル時に呼べない**（ランタイムトラップ
ではなく構造的な型制約）。`collectEvents` も入っていないので、readonly 経路から
誤って outbox にイベントを流し込むことはできない。

```typescript
const { items, count } = await container.unitOfWorkProvider.runReadonly(
  ({ postRepository }) =>
    postRepository.findByUserId(userId, { page: 1, limit: 20 }),
);
```

### Context 型の俯瞰

`app/core/application/execution/unitOfWork.ts` には 3 種類のコンテキスト型がある：

- `ReadonlyContext` — `{ postRepository: PostReader, ... }` のみ。
  `save` / `delete` / `saveEvents` / `collectEvents` は型レベルで不可。
- `ReadWriteContext` — `{ postRepository: PostRepository, collectEvents, ... }`。
  ドメイン変更と outbox へのイベント投入を同一トランザクションで行う。
  `outboxRepository` を直接触ることは **できない**。イベントは必ず
  `collectEvents`（配列シグネチャ）を経由する。
- `WorkerContext` — `{ outboxRepository, [workerContextMarker]: true }`。
  outbox を claim / markProcessed する relay ワーカー専用。ドメインリポジトリ
  は入っていないので、ワーカーから entity を変更する経路が型で閉じられている。
  phantom な `unique symbol` マーカーで他の 2 コンテキストと **非互換** 。

`UnitOfWorkProvider` には 3 つの入口が生えている：

```typescript
export interface UnitOfWorkProvider {
  runReadonly<T>(fn: (ctx: ReadonlyContext) => Promise<T>): Promise<T>;
  runReadWrite<T>(fn: (ctx: ReadWriteContext) => Promise<T>): Promise<T>;
  // outbox relay worker 専用。
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T>;
}
```

ユースケース実装で `runWorker` を呼ぶことは **ない**。relay worker 以外は
`runReadonly` / `runReadWrite` のどちらかだけを使い、`runWorker` は
`app/core/application/workers/` の下からしか呼ばれない想定。

### バリデーションとエラー

入力バリデーションは presentation 層の `inputValidator` と、必要に応じて
application 層の先頭でもう一度 zod を通す。application 層側の検査失敗は
`ValidationError(InvalidInput)` を投げる。ドメインルール違反（空タイトル等）は
`BusinessRuleError` のまま伝搬させ、presentation 側で `displayError` がユーザー向け
メッセージに畳む。

各エラークラス（`BusinessRuleError`, `NotFoundError`, `ConflictError`,
`ValidationError`, `SystemError`, `AppServerError` など）は自前で
`toSerialized(): SerializedError` を持つ。presentation 層は `instanceof` で
具象クラスを列挙せず、構造的契約 `SerializableError`（`isSerializableError`
ガード）にだけ依存して `error.toSerialized()` を呼ぶ。新しいエラー型を
追加するときは `toSerialized` を実装するだけで presentation を一切触らずに
配線が完了する。

```typescript
// 例: 新しい SystemError 派生に近い独自エラーを追加するとき
class StorageQuotaExceededError extends SystemError {
  constructor(message: string, cause?: unknown) {
    super(SystemErrorCode.ExternalApiError, message, cause);
  }
  // 親クラスの toSerialized() がそのまま使えるならオーバーライド不要。
  // 表示メッセージを変えたいときだけ override する：
  override toSerialized(): SerializedError {
    return {
      kind: "system",
      code: this.code,
      message: "ストレージ容量が不足しています",
      retryable: this.retryable,
    };
  }
}
```

`BusinessRuleError` は `BusinessRuleError<TCode extends string = string>` の
ジェネリッククラスとして定義されているので、ドメインごとに `TCode` を narrow
した別名を作っておくと catch 側で `error.code` が literal union に絞り込める：

```typescript
// 例: PostErrorCode の union を narrow
type PostRuleError = BusinessRuleError<
  (typeof PostErrorCode)[keyof typeof PostErrorCode]
>;
```

```typescript
// 例: listTodos (本テンプレートの実装)
import { paginationSchema } from "@/core/domain/common/pagination";
import { ValidationError, ValidationErrorCode } from "../errors";

function parseInput(input: ListTodosInput | undefined): Pagination {
  if (input === undefined) return DEFAULT_PAGINATION;
  const parsed = paginationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(
      ValidationErrorCode.InvalidInput,
      "Invalid pagination input",
      parsed.error,
    );
  }
  return parsed.data;
}
```

プレゼンテーション層でエラーをシリアライズして server function の戻り値に
載せるヘルパー `withErrorResponse` は、TanStack Router の `redirect()` /
`notFound()` が投げるセンチネルだけは素通しする。これらはエラーではなく
制御フロー（ナビゲーション駆動）なので、`AppServerError` に包むと router
が拾えなくなってしまう。

## DI Container

サーバー側のコンテナは `getContainer()` で遅延構築・module-scope でメモ化する。
構築は **非同期** だ（ローカル `file:` DB への WAL PRAGMA が `await` される）。
`getContainer()` は `Promise<Container>` を返し、**解決済みの値ではなく
in-flight の Promise** をキャッシュする。これにより起動直後に複数のリクエスト
が殺到しても、DB コネクションや WAL PRAGMA の初期化は一度しか走らない。

`createServerFn` の `handler` や server component からは `await getContainer()`
で取得する。RSC 有効化時もサーバー側モジュールはサーバーバンドルにしか含まれ
ないので `process.env` 参照や server-only API もクライアントに漏れない。

UoW は `Retrying(DrizzleSqlite(db))` で合成して、`SQLITE_BUSY` 系の transient
エラーをアダプタに依存しない decorator（`RetryingUnitOfWorkProvider`）で吸収する。
decorator はコールバックそのものを再実行するので、**DB 外の副作用**
（HTTP 呼び出し、外部キューへの push、メモリキャッシュへの書き込み等）は
リトライ回数ぶん重複する点に注意する。副作用は `run` / `runWorker` が
resolve したあとに実行し、コールバック内は DB と `collectEvents` のみで
閉じておくのが基本。

`RetryingUnitOfWorkProvider` の内部で使う `retry(fn, options)` は
TypeScript 標準の `throw` / `try / catch` の上に乗った素朴な
`Promise<T>` API で、独自の Result 型は導入しない。

```typescript
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T>;

type RetryOptions = Readonly<{
  maxAttempts: number;
  shouldRetry: (error: unknown) => boolean;
  delayMs?: (attempt: number) => number | Promise<number>;
  onRetry?: (attempt: number, error: unknown) => void;
}>;
```

挙動はシンプル。`fn()` を呼んで成功すれば値を返す。失敗時は
`shouldRetry(error)` で判定し、retryable でなければ即 throw、retryable な
ら指数バックオフで `maxAttempts` まで再試行し、それでも尽きたら **最後の
エラーをそのまま throw** する（カスタム wrapper には包まない）。エラーの
identity（typed subclass・`code`・`cause`）が呼び出し側まで素通しで届く。
attempt 数を観測したいときは `onRetry(attempt, error)` フックを渡し、
caller 側で記録する。

「retryable だが予算切れ」を typed なアプリケーションエラー
（例: `ConflictError`）に変換したい場合は、`retry()` を `try / catch` で
囲って同じ `shouldRetry` 述語を catch 側で再実行する。

```typescript
let attemptsRun = 1;
try {
  const next = await retry(
    () => container.unitOfWorkProvider.runReadWrite(/* ... */),
    {
      maxAttempts: MAX_OCC_ATTEMPTS,
      shouldRetry: isOptimisticLockFailure,
      onRetry: (attempt) => {
        attemptsRun = attempt + 1;
      },
    },
  );
  return { todo: toTodoView(next) };
} catch (error) {
  if (
    attemptsRun >= MAX_OCC_ATTEMPTS &&
    isOptimisticLockFailure(error) &&
    isConflictError(error)
  ) {
    throw new ConflictError(
      ConflictErrorCode.OptimisticLockFailure,
      `Failed after ${attemptsRun} attempts due to concurrent writers`,
      error,
    );
  }
  throw error;
}
```

`RetryingUnitOfWorkProvider` 自体は `runReadonly` / `runReadWrite` /
`runWorker` のシグネチャ互換を保ったまま内部で `retry()` を呼ぶだけ
（throw はそのまま透過）なので、ユースケース側のコードは何も変わらない。
`retry()` を直接使うのは「冪等なコマンドの中で OCC conflict をローカルに
リトライしたい」など特殊なケースだけになる。

```typescript
// app/core/application/di/server.ts

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import { type Clock, SystemClock } from "@/core/domain/common/ports/clock";
import { ConsoleLogger, type Logger } from "@/core/domain/common/ports/logger";
import { RetryingUnitOfWorkProvider } from "../execution/retryingUnitOfWork";
import type { UnitOfWorkProvider } from "../execution/unitOfWork";

export type AppConfig = { appUrl: string };

export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  // Clock / Logger はトランザクション資源ではないので UoW の context に
  // 載せない。container 直下に置くことで「`runReadWrite` の callback が
  // 走っているかどうか」と無関係に呼び出せ、かつ context 同士の
  // unique-symbol 非互換不変条件（ReadOnly / ReadWrite / Worker が相互に
  // assign 不可）を壊さずに済む。
  clock: Clock;
  logger: Logger;
  // authProvider, storageManager, ... — 必要に応じて追加
};

export type ServerConfig = { databaseUrl: string; appUrl: string };

/**
 * getDatabase が WAL PRAGMA を await するので createContainer も async。
 * コンテナを返す前に WAL モードへの切り替えが済んでいることを保証する。
 */
export async function createContainer(config: ServerConfig): Promise<Container> {
  const db = await getDatabase(config.databaseUrl);
  const innerUow = new DrizzleSqliteUnitOfWorkProvider(db);
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider: new RetryingUnitOfWorkProvider(innerUow, isRetryableError),
    clock: SystemClock,
    logger: ConsoleLogger,
  };
}

// `Promise<Container>` をキャッシュする。値ではなく Promise を memoize する
// ことで、起動直後の並行初期化でも二重に DB コネクションを張らずに済む。
let _containerPromise: Promise<Container> | null = null;
export function getContainer(): Promise<Container> {
  if (_containerPromise !== null) return _containerPromise;
  _containerPromise = createContainer(getServerConfig());
  return _containerPromise;
}
```

```typescript
// サーバーコンポーネントから呼ぶ例
import { getRequestHeaders } from "@tanstack/react-start/server";
import { listPosts } from "@/core/application/post/listPosts";
import { getContainer } from "@/core/application/di/server";

export async function PostList() {
  const container = await getContainer();
  const { posts } = await listPosts({
    container,
    headers: getRequestHeaders(),
    input: { page: 1, limit: 20 },
  });
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}
```

```typescript
// mutation 用の server function
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { createPost } from "@/core/application/post/createPost";
import { getContainer } from "@/core/application/di/server";

export const createPostFn = createServerFn({ method: "POST" })
  .inputValidator(createPostSchema)
  .handler(async ({ data }) =>
    createPost({
      container: await getContainer(),
      headers: getRequestHeaders(),
      input: data,
    }),
  );
```

`Container` の型宣言は DI ファイル内に同居させる（別ファイルに分けない）。
クライアント側 DI は存在しない — 純粋なフロントエンドロジックは DI を介さず
直接 import し、サーバー資源は必ず server function / server component 経由で
呼ぶ、という境界で十分分離できるので `app/core/application/di/client.ts`
は意図的に用意していない。

## Event Relay Worker example

outbox を drain する relay worker は `runWorker` で `WorkerContext` を開く。
`runReadonly` / `runReadWrite` では `outboxRepository` が型に出てこないので、
通常のユースケースから誤って claim / markProcessed を呼ぶことはない。

dispatch は claim トランザクションの **外側** で行う。もし `runWorker` 内部で
HTTP dispatch してしまうと、DB 側の retryable error が発生した際に
`RetryingUnitOfWorkProvider` がコールバック全体を再実行し、既に送った dispatch
が重複して発火してしまう。claim → decode → dispatch (外) → markProcessed (別
`runWorker`) の四段にわけるのが定石。

```typescript
// app/core/application/workers/eventRelayWorker.ts (抜粋)

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  const registry = options.decoderRegistry ?? defaultEventDecoderRegistry;

  const { logger, clock } = container;

  // 1) 未配信の行を atomic に claim。`claim` は `{ entries, handle }`。
  //    `handle` は `OutboxClaimHandle` を継承したアダプタ subclass で、
  //    nominal brand と instanceof チェックで「他アダプタの handle を
  //    紛れ込ませる」事故を実行時に弾く。lease token は subclass の
  //    内部にあり、port 表面には出てこない。
  //    現在時刻は `Clock` ポートから引き、worker テストで時間を
  //    決定論的に進められるようにする。
  const claim = await container.unitOfWorkProvider.runWorker(
    ({ outboxRepository }) =>
      outboxRepository.claimPending(batchSize, leaseDurationMs, clock.now()),
  );
  if (claim.entries.length === 0) return { processed: 0 };

  // 2) Decode パス。decode 失敗は Result の error チャネルで来る。
  //    1 行壊れているだけで全バッチを落とさないよう、skip + logger.error
  //    して残りを進める。markProcessed に **含めない** ので、リース切れ
  //    後に別ワーカーが再 claim して正常な decode を試せる。`Logger`
  //    ポート経由なので、本番ではここを構造化ロガーに差し替えてアラート
  //    対象にできる。
  const decoded: { id: string; event: DomainEvent }[] = [];
  for (const entry of claim.entries) {
    const result = registry.decode({
      type: entry.event.type,
      payload: entry.event.payload,
      meta: {
        id: entry.event.id,
        occurredAt: entry.event.occurredAt,
        schemaVersion: entry.schemaVersion,
        aggregateId: entry.event.aggregateId,
      },
    });
    if (result.ok) {
      decoded.push({ id: entry.id, event: result.event });
    } else {
      logger.error(`[outbox] decode failed for event ${entry.event.id}`, {
        eventId: entry.event.id,
        eventType: entry.event.type,
        cause: result.error,
      });
    }
  }
  if (decoded.length === 0) return { processed: 0 };

  // 3) dispatch はトランザクション外。retry で重複させないため。consumer は
  //    idempotent であること（at-least-once）。`Promise.allSettled` で個別
  //    失敗を許容し、成功した行だけ markProcessed へ回す。
  const results = await Promise.allSettled(
    decoded.map((row) => dispatch(row.event)),
  );
  const dispatchedIds: string[] = [];
  results.forEach((r, i) => {
    const row = decoded[i];
    if (!row) return;
    if (r.status === "fulfilled") {
      dispatchedIds.push(row.id);
    } else {
      logger.error(`[outbox] dispatch failed for event ${row.event.id}`, {
        eventId: row.event.id,
        eventType: row.event.type,
        cause: r.reason,
      });
    }
  });
  if (dispatchedIds.length === 0) return { processed: 0 };

  // 4) 自分が保持した `handle` で scope して processed に更新。他ワーカーが
  //    expire 後に再 claim した行には触らない。
  await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
    outboxRepository.markProcessed(claim.handle, dispatchedIds),
  );
  return { processed: dispatchedIds.length };
}
```

outbox アダプタの `saveEvents` は各 `event.schemaVersion` を直接読んで
行に書き込む。ドメインをまたぐ `schemaVersionFor(type)` 的なマッピング
関数は **存在しない** — 各ドメインがイベントファクトリで
`schemaVersion: POST_EVENT_SCHEMA_VERSION` などとスタンプしておき、
adapter はその値をそのまま列に流す。結果として outbox アダプタは
ドメインに非依存で、新しいドメインを追加しても adapter 側を触る必要がない。

dispatcher 側で typed な payload を扱いたい場合は、ドメインごとの decode 関数
（`decodeTodoEvent` / `decodePostEvent`）を `createEventDecoderRegistry` で
束ねて渡せばよい。worker はイベントタイプ prefix（`"todo.created"` なら
`"todo"`）をキーに適切な decode 関数を引き当てる。`schemaVersion` を見て
互換分岐を書くのはこのレイヤー。
