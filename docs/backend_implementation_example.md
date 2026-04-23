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
import type {
  PostContent as PostContentType,
  PostId as PostIdType,
} from "./valueObject";

type PostBase = Readonly<{
  id: PostIdType;
  userId: UserId;
  content: PostContentType;
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
function publish(post: DraftPost): WithEvents<PublishedPost, PostEvent> {
  const next: PublishedPost = {
    ...post,
    status: "published",
    version: post.version + 1,
    updatedAt: new Date(),
  };
  return {
    entity: next,
    events: [PostEvents.published(next.id)],
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
   */
  create: (params: {
    userId: UserId;
    content: string;
  }): WithEvents<DraftPost, PostEvent> => {
    const now = new Date();
    const post: DraftPost = {
      id: PostId.generate(),
      userId: params.userId,
      content: PostContent.create(params.content),
      status: "draft",
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
    return { entity: post, events: [PostEvents.created(post.id, params.userId)] };
  },

  publish,

  /**
   * 削除は terminal な操作で後続エンティティが存在しないので、戻り値は
   * `WithEvents<null, …>` ではなく生のイベント配列。呼び出し側は
   * `const events = Post.delete(post); collectEvents(events);`
   * の形で outbox に流し込む。
   */
  delete: (post: Post): readonly PostEvent[] => [PostEvents.deleted(post.id)],
};
```

`Post.fromPersistence` のような「DB 行 → エンティティ」を担うスタティック
メソッドは **定義しない**。再ハイドレーションはアダプタ内部の private な
`rowToPost` に閉じ込める（後述）。ドメイン層は永続化スキーマを知らずに
済む。

## Value Objects example

```typescript
// app/core/domain/post/valueObject.ts

import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { BusinessRuleError } from "@/core/domain/error";
import { PostErrorCode } from "./errorCode";

const POST_CONTENT_MAX_LENGTH = 5000;

type PostId = string & { readonly brand: "PostId" };
export type { PostId };

export const PostId = {
  create: (id: string): PostId => id as PostId,
  generate: (): PostId => uuidv7() as PostId,
};

// zod の schema を公開しておくと、server function 側の inputValidator や
// Conform の constraint にそのまま流用できる。
const postContentSchema = z
  .string()
  .trim()
  .min(1)
  .max(POST_CONTENT_MAX_LENGTH)
  .brand<"PostContent">();

type PostContent = z.infer<typeof postContentSchema>;
export type { PostContent };

export const PostContent = {
  schema: postContentSchema,
  maxLength: POST_CONTENT_MAX_LENGTH,
  create: (raw: string): PostContent => {
    const result = postContentSchema.safeParse(raw);
    if (result.success) return result.data;
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

イベントの `payload` は wire 型として宣言する（branded 値オブジェクトは
シリアライズ時にただの string に畳まれる）。永続化境界を跨いで読み出すときは
専用の decode 関数で value object を再生成してから consumer に渡す。

`DomainEventBase` には `schemaVersion: number` が **必須** で乗っている。
各ドメインは自前の `*_EVENT_SCHEMA_VERSION` 定数を定義し、イベント
ファクトリが必ずスタンプする。outbox アダプタは `event.schemaVersion` を
そのまま列に書き込むだけで、ドメイン横断の "type → version" マッピングを
持つ必要がない。

```typescript
// app/core/domain/post/events.ts

import { v7 as uuidv7 } from "uuid";
import type { DomainEventBase } from "@/core/domain/common/event";
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

export type PostCreatedEvent = DomainEventBase<
  "post.created",
  { postId: PostId; userId: UserId }
>;

export type PostPublishedEvent = DomainEventBase<
  "post.published",
  { postId: PostId }
>;

export type PostDeletedEvent = DomainEventBase<
  "post.deleted",
  { postId: PostId }
>;

export type PostEvent =
  | PostCreatedEvent
  | PostPublishedEvent
  | PostDeletedEvent;

export const PostEvents = {
  created: (postId: PostId, userId: UserId): PostCreatedEvent => ({
    id: uuidv7(),
    type: "post.created",
    payload: { postId, userId },
    occurredAt: new Date(),
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),

  published: (postId: PostId): PostPublishedEvent => ({
    id: uuidv7(),
    type: "post.published",
    payload: { postId },
    occurredAt: new Date(),
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),

  deleted: (postId: PostId): PostDeletedEvent => ({
    id: uuidv7(),
    type: "post.deleted",
    payload: { postId },
    occurredAt: new Date(),
    schemaVersion: POST_EVENT_SCHEMA_VERSION,
    aggregateId: postId,
  }),
};

/**
 * 永続化境界で読んだ payload を typed な PostEvent に戻す。
 *
 * `meta.schemaVersion` は outbox 行の `schema_version` 列から供給される
 * （decode 済みのイベントに再び乗せ直すため `base.schemaVersion` にも入れる）。
 * 値を見て将来の互換分岐を書くのはこのレイヤー。
 */
export function decodePostEvent(
  type: string,
  payload: Record<string, unknown>,
  meta: {
    id: string;
    occurredAt: Date;
    aggregateId?: string;
    schemaVersion: number;
  },
): PostEvent {
  if (meta.schemaVersion !== POST_EVENT_SCHEMA_VERSION) {
    throw new BusinessRuleError(
      PostErrorCode.UnsupportedEventSchema,
      `Unsupported post event schema version: ${meta.schemaVersion}`,
    );
  }
  const base = {
    id: meta.id,
    occurredAt: meta.occurredAt,
    schemaVersion: meta.schemaVersion,
    ...(meta.aggregateId !== undefined
      ? { aggregateId: meta.aggregateId }
      : {}),
  };
  const postId = PostId.create(String(payload.postId));
  // ... 以下、type ごとに value object を組み直して返す
  switch (type) {
    case "post.created":
    case "post.published":
    case "post.deleted":
    // ...
  }
  throw new BusinessRuleError(
    PostErrorCode.UnknownEventType,
    `Unknown post event type: ${type}`,
  );
}
```

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

Outbox も同じパターン：

```typescript
// app/core/domain/common/ports/outboxRepository.ts (抜粋)

export interface OutboxReader {
  findPendingEvents(limit: number): Promise<readonly OutboxEntry[]>;
}

export interface OutboxRepository extends OutboxReader {
  saveEvents(events: readonly DomainEvent[]): Promise<void>;
  claimPending(batchSize: number, leaseDurationMs: number, now: Date): Promise<readonly ClaimedOutboxEntry[]>;
  // `entries` は claimPending が返した leaseToken とセットで渡す。
  // WHERE lease_token = ? で scope されるので、他ワーカーが再claim した行は更新されない。
  markProcessed(entries: readonly Pick<ClaimedOutboxEntry, "id" | "leaseToken">[]): Promise<void>;
}
```

## Adapters example

アダプタは reader クラスと repository クラスの 2 種類を export し、
repository は reader を `extends` する。UoW は `{ mode: "readonly" }` の
とき reader を、readwrite のとき repository をインスタンス化して context
に組み立てる。

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
} from "@/core/application/error";
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
import { UnauthenticatedError, UnauthenticatedErrorCode } from "../error";
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

  const { entity: post, events } = Post.create({
    userId: currentUser.id,
    content: input.content,
  });

  // Outbox パターン: エンティティ変更とイベント保存を同一トランザクションで
  // 実行。`collectEvents` で受け取ったイベントは run() が終わる直前に outbox
  // へ flush される。worker 専用の `outboxRepository` は `ReadWriteContext`
  // に入っていないので、ユースケースから直接 saveEvents を呼ぶことはできない。
  await container.unitOfWorkProvider.run(async ({ postRepository, collectEvents }) => {
    await postRepository.save(post);
    collectEvents(events);
  });

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

削除のユースケースでは `Post.delete` が返す event 配列を明示的に
`collectEvents` へ流す：

```typescript
// app/core/application/post/deletePost.ts (抜粋)

const post = await postRepository.findById(input.postId);
if (!post) throw new NotFoundError(NotFoundErrorCode.PostNotFound, "...");

const events = Post.delete(post);
await postRepository.delete(post.id, post.version);
collectEvents(events);
```

### read-only mode

副作用を持たない参照系ユースケースは `run(fn, { mode: "readonly" })` で
`ReadonlyContext` を受け取る。`postRepository: PostReader` に narrow されて
いるので、`save` / `delete` は **コンパイル時に呼べない**（ランタイムトラップ
ではなく構造的な型制約）。`collectEvents` も入っていないので、readonly 経路から
誤って outbox にイベントを流し込むことはできない。

```typescript
const { items, count } = await container.unitOfWorkProvider.run(
  ({ postRepository }) =>
    postRepository.findByUserId(userId, { page: 1, limit: 20 }),
  { mode: "readonly" },
);
```

### Context 型の俯瞰

`app/core/application/unitOfWork.ts` には 3 種類のコンテキスト型がある：

- `ReadonlyContext` — `{ postRepository: PostReader, ... }` のみ。
  `save` / `delete` / `saveEvents` / `collectEvents` は型レベルで不可。
- `ReadWriteContext` — `{ postRepository: PostRepository, collectEvents, ... }`。
  ドメイン変更と outbox へのイベント投入を同一トランザクションで行う。
  `outboxRepository` を直接触ることは **できない**。イベントは必ず
  `collectEvents`（配列シグネチャ）を経由する。
- `WorkerContext` — `{ outboxRepository }` のみ。outbox を claim /
  markProcessed する relay ワーカー専用。ドメインリポジトリは入っていない
  ので、ワーカーから entity を変更する経路が型で閉じられている。

これら 3 つを揃えるため、`UnitOfWorkProvider` には `run` と `runWorker` の
2 つが生えている：

```typescript
export interface UnitOfWorkProvider {
  // 通常のユースケース向け。ReadWriteContext がデフォルト。
  run<T>(fn: (ctx: ReadWriteContext) => Promise<T>, options?: { mode?: "readwrite" }): Promise<T>;
  run<T>(fn: (ctx: ReadonlyContext) => Promise<T>, options: { mode: "readonly" }): Promise<T>;

  // outbox relay worker 専用。WorkerContext を開く。
  runWorker<T>(fn: (ctx: WorkerContext) => Promise<T>): Promise<T>;
}
```

ユースケース実装で `runWorker` を呼ぶことは **ない**。relay worker 以外は
`run` だけを使い、`runWorker` は `app/core/application/workers/` の下から
しか呼ばれない想定。

### バリデーションとエラー

入力バリデーションは presentation 層の `inputValidator` と、必要に応じて
application 層の先頭でもう一度 zod を通す。application 層側の検査失敗は
`ValidationError(InvalidInput)` を投げる。ドメインルール違反（空タイトル等）は
`BusinessRuleError` のまま伝搬させ、presentation 側で `displayError` がユーザー向け
メッセージに畳む。

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
import { ValidationError, ValidationErrorCode } from "../error";

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

```typescript
// app/core/application/di/server.ts

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import { RetryingUnitOfWorkProvider } from "../retryingUnitOfWork";
import type { UnitOfWorkProvider } from "../unitOfWork";

export type AppConfig = { appUrl: string };

export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
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
`run` では `outboxRepository` が型に出てこないので、通常のユースケースから
誤って claim / markProcessed を呼ぶことはない。

dispatch は claim トランザクションの **外側** で行う。もし `runWorker` 内部で
HTTP dispatch してしまうと、DB 側の retryable error が発生した際に
`RetryingUnitOfWorkProvider` がコールバック全体を再実行し、既に送った dispatch
が重複して発火してしまう。claim → dispatch (外) → markProcessed (別 runWorker)
の三段にわけるのが定石。

```typescript
// app/core/application/workers/eventRelayWorker.ts (抜粋)

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  // 1) 未配信の行を atomic に claim。lease_token とリース期限がスタンプされる。
  //    `runWorker` は WorkerContext を開くので outboxRepository だけが見える。
  const entries = await container.unitOfWorkProvider.runWorker(
    ({ outboxRepository }) =>
      outboxRepository.claimPending(batchSize, leaseDurationMs, new Date()),
  );
  if (entries.length === 0) return { processed: 0 };

  // 2) dispatch はトランザクション外。retry で重複させないため。
  //    consumer は idempotent であること（at-least-once）。
  const dispatched: { id: string; leaseToken: string }[] = [];
  for (const entry of entries) {
    await dispatch({
      id: entry.event.id,
      type: entry.event.type,
      payload: entry.event.payload,
      occurredAt: entry.event.occurredAt,
      schemaVersion: entry.schemaVersion,
      ...(entry.event.aggregateId !== undefined ? { aggregateId: entry.event.aggregateId } : {}),
    });
    dispatched.push({ id: entry.id, leaseToken: entry.leaseToken });
  }

  // 3) 自分が保持した leaseToken で scope して processed に更新。
  //    他ワーカーが expire 後に再 claim した行には触らない。
  await container.unitOfWorkProvider.runWorker(({ outboxRepository }) =>
    outboxRepository.markProcessed(dispatched),
  );
  return { processed: dispatched.length };
}
```

outbox アダプタの `saveEvents` は各 `event.schemaVersion` を直接読んで
行に書き込む。ドメインをまたぐ `schemaVersionFor(type)` 的なマッピング
関数は **存在しない** — 各ドメインがイベントファクトリで
`schemaVersion: POST_EVENT_SCHEMA_VERSION` などとスタンプしておき、
adapter はその値をそのまま列に流す。結果として outbox アダプタは
ドメインに非依存で、新しいドメインを追加しても adapter 側を触る必要がない。

dispatcher 側で typed な payload を扱いたい場合は、ドメインごとの decode 関数
（`decodeTodoEvent` / `decodePostEvent`）を通してから consumer に渡す。
`schemaVersion` を見て互換分岐を書くのはこのレイヤー。
