# Backend Implementation Example

ドメイン層・アダプタ層・アプリケーション層は TanStack Start (RSC) と
直接結びつかない、フレームワーク非依存の純粋な TypeScript で書く。
プレゼンテーション層（loader / `createServerFn` / コンポーネント）の例は
`docs/frontend_implementation_example.md` を参照。


## Entities example

```typescript
// app/core/domain/post/entity.ts

import type { UserId } from "@/core/domain/user/valueObject";
import type { WithEvents } from "@/core/domain/common/event";
import { PostId, PostContent } from "./valueObject";
import type { PostId as PostIdType, PostContent as PostContentType } from "./valueObject";
import { PostEvents, type PostEvent } from "./events";

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

export type { Post, DraftPost, PublishedPost };

export const Post = {
  create: (params: { userId: UserId; content: string }): WithEvents<DraftPost, PostEvent> => {
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

  // `version` は更新のたびに +1 する。アダプタは `WHERE version = ? - 1` で
  // optimistic lock を掛けて lost-update を検出する。
  publish: (post: DraftPost): WithEvents<PublishedPost, PostEvent> => ({
    entity: {
      ...post,
      status: "published",
      version: post.version + 1,
      updatedAt: new Date(),
    },
    events: [PostEvents.published(post.id)],
  }),

  isDraft: (post: Post): post is DraftPost => post.status === "draft",
  isPublished: (post: Post): post is PublishedPost => post.status === "published",
};
```

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
const postContentSchema = z.string().trim().min(1).max(POST_CONTENT_MAX_LENGTH).brand<"PostContent">();

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

```typescript
// app/core/domain/post/events.ts

import { v7 as uuidv7 } from "uuid";
import type { DomainEventBase } from "@/core/domain/common/event";
import { BusinessRuleError } from "@/core/domain/error";
import { PostErrorCode } from "./errorCode";
import { PostId } from "./valueObject";
import type { UserId } from "@/core/domain/user/valueObject";

export const POST_EVENT_SCHEMA_VERSION = 1 as const;

export type PostCreatedEvent = DomainEventBase<
  "post.created",
  { postId: PostId; userId: UserId }
>;

export type PostPublishedEvent = DomainEventBase<
  "post.published",
  { postId: PostId }
>;

export type PostEvent = PostCreatedEvent | PostPublishedEvent;

export const PostEvents = {
  created: (postId: PostId, userId: UserId): PostCreatedEvent => ({
    id: uuidv7(),
    type: "post.created",
    payload: { postId, userId },
    occurredAt: new Date(),
    aggregateId: postId,
  }),

  published: (postId: PostId): PostPublishedEvent => ({
    id: uuidv7(),
    type: "post.published",
    payload: { postId },
    occurredAt: new Date(),
    aggregateId: postId,
  }),
};

// 永続化境界で読んだ payload を typed な PostEvent に戻す。
// schemaVersion で将来の互換分岐を入れられる。
export function decodePostEvent(
  type: string,
  payload: Record<string, unknown>,
  meta: { id: string; occurredAt: Date; aggregateId?: string; schemaVersion: number },
): PostEvent {
  if (meta.schemaVersion !== POST_EVENT_SCHEMA_VERSION) {
    throw new BusinessRuleError(
      PostErrorCode.UnsupportedEventSchema,
      `Unsupported post event schema version: ${meta.schemaVersion}`,
    );
  }
  // ... 以下、type ごとに value object を組み直して返す
}
```

## Ports example

Read-only なユースケース（list / get 系）と read/write なユースケースで
呼べるメソッドを型で分けるため、port は `*Reader` と `*Repository` の
二段構成にする。`*Repository` は `*Reader` を継承して save/delete を追加
する。

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
  delete(id: PostId): Promise<void>;
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

```typescript
// app/core/adapters/drizzleSqlite/repositories/postRepository.ts

import { and, eq, sql } from "drizzle-orm";
import { ConflictError, ConflictErrorCode } from "@/core/application/error";
import type { Pagination, PaginationResult } from "@/core/domain/common/pagination";
import { Post } from "@/core/domain/post/entity";
import type { PostReader, PostRepository } from "@/core/domain/post/ports/postRepository";
import type { PostId } from "@/core/domain/post/valueObject";
import type { UserId } from "@/core/domain/user/valueObject";
import type { Executor } from "../client";
import { posts } from "../schema";
import { mapDbError, rehydrate } from "./helpers";

export class DrizzlePostReader implements PostReader {
  constructor(protected readonly executor: Executor) {}

  findById(id: PostId): Promise<Post | null> {
    return mapDbError("Failed to find post", async () => {
      const rows = await this.executor.select().from(posts).where(eq(posts.id, id)).limit(1);
      const row = rows[0];
      return row ? rehydrate("post", () => Post.fromPersistence(row)) : null;
    });
  }

  findByUserId(userId: UserId, pagination: Pagination): Promise<PaginationResult<Post>> {
    return mapDbError("Failed to find posts", async () => {
      const offset = (pagination.page - 1) * pagination.limit;
      const [rows, countRows] = await Promise.all([
        this.executor.select().from(posts).where(eq(posts.userId, userId)).limit(pagination.limit).offset(offset),
        this.executor.select({ count: sql<number>`count(*)` }).from(posts).where(eq(posts.userId, userId)),
      ]);
      return {
        items: rows.map((r) => rehydrate("post", () => Post.fromPersistence(r))),
        count: Number(countRows[0]?.count ?? 0),
      };
    });
  }
}

export class DrizzlePostRepository extends DrizzlePostReader implements PostRepository {
  async save(post: Post): Promise<void> {
    if (post.version === 0) {
      await mapDbError("Failed to insert post", () => this.executor.insert(posts).values(post));
      return;
    }
    // version > 0 → optimistic-lock-guarded UPDATE。
    // ON CONFLICT DO UPDATE (upsert) は lost update を隠すので使わない。
    const updated = await mapDbError("Failed to update post", () =>
      this.executor
        .update(posts)
        .set({ ...post })
        .where(and(eq(posts.id, post.id), eq(posts.version, post.version - 1)))
        .returning({ id: posts.id }),
    );
    if (updated.length === 0) {
      throw new ConflictError(
        ConflictErrorCode.OptimisticLockFailure,
        `Optimistic lock failure while saving post ${post.id}`,
      );
    }
  }

  async delete(id: PostId): Promise<void> {
    await mapDbError("Failed to delete post", () => this.executor.delete(posts).where(eq(posts.id, id)));
  }
}
```

`rehydrate` / `mapDbError` は `app/core/adapters/drizzleSqlite/repositories/helpers.ts`
に置いてある共通ヘルパー。`Post.fromPersistence` が投げる `BusinessRuleError` を
`SystemError(DatabaseError)` に畳み、DB エラーに一貫した message を付与する。

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
import type { AuthedServiceArgs } from "../types";
import { UnauthenticatedError, UnauthenticatedErrorCode } from "../error";
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
  // 実行。`collectEvent` で拾ったイベントは run() が終わる直前に outbox へ
  // flush される。
  await container.unitOfWorkProvider.run(async ({ postRepository, collectEvent }) => {
    await postRepository.save(post);
    for (const event of events) collectEvent(event);
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

### read-only mode

副作用を持たない参照系ユースケースは `run(fn, { mode: "readonly" })` で
`ReadonlyContext` を受け取る。`todoRepository: TodoReader` / `outboxRepository:
OutboxReader` に narrow されているので、`save` / `delete` / `saveEvents` などの
書き込みメソッドは **コンパイル時に呼べない**（ランタイムトラップではなく
構造的な型制約）。

```typescript
const { items, count } = await container.unitOfWorkProvider.run(
  ({ todoRepository }) => todoRepository.findPage({ page: 1, limit: 20 }),
  { mode: "readonly" },
);
```

### バリデーションとエラー

入力バリデーションは presentation 層の `inputValidator` と、必要に応じて
application 層の先頭でもう一度 zod を通す。application 層側の検査失敗は
`ValidationError(InvalidInput)` を投げる。ドメインルール違反（空タイトル等）は
`BusinessRuleError` のまま伝搬させ、presentation 側で `displayError` がユーザー向け
メッセージに畳む。

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

## DI Container

サーバー側のコンテナは `getContainer()` で遅延構築・module-scope でメモ化する。
`createServerFn` の `handler` や server component からそのまま `getContainer()` を
呼び出して使う。RSC 有効化時もサーバー側モジュールはサーバーバンドルにしか
含まれないので `process.env` 参照や server-only API もクライアントに漏れない。

UoW は `Retrying(DrizzleSqlite(db))` で合成して、`SQLITE_BUSY` 系の transient
エラーをアダプタに依存しない decorator（`RetryingUnitOfWorkProvider`）で吸収する。

```typescript
// app/core/application/di/server.ts

import "@tanstack/react-start/server-only";

import { getDatabase } from "@/core/adapters/drizzleSqlite/client";
import {
  DrizzleSqliteUnitOfWorkProvider,
  isRetryableError,
} from "@/core/adapters/drizzleSqlite/unitOfWork";
import { RetryingUnitOfWorkProvider } from "../retryingUnitOfWork";

export type AppConfig = { appUrl: string };

export type Container = {
  config: AppConfig;
  unitOfWorkProvider: UnitOfWorkProvider;
  // authProvider, storageManager, ... — 必要に応じて追加
};

export type ServerConfig = { databaseUrl: string; appUrl: string };

export function createContainer(config: ServerConfig): Container {
  const db = getDatabase(config.databaseUrl);
  const innerUow = new DrizzleSqliteUnitOfWorkProvider(db);
  return {
    config: { appUrl: config.appUrl },
    unitOfWorkProvider: new RetryingUnitOfWorkProvider(innerUow, isRetryableError),
  };
}

let _container: Container | null = null;
export function getContainer(): Container {
  if (_container !== null) return _container;
  _container = createContainer(getServerConfig());
  return _container;
}
```

```typescript
// サーバーコンポーネントから呼ぶ例
import { getContainer } from "@/core/application/di/server";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { listPosts } from "@/core/application/post/listPosts";

export async function PostList() {
  const { posts } = await listPosts({
    container: getContainer(),
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
import { getContainer } from "@/core/application/di/server";
import { createPost } from "@/core/application/post/createPost";

export const createPostFn = createServerFn({ method: "POST" })
  .inputValidator(createPostSchema)
  .handler(({ data }) =>
    createPost({
      container: getContainer(),
      headers: getRequestHeaders(),
      input: data,
    }),
  );
```

`Container` の型宣言は DI ファイル内に同居させる（別ファイルに分けない）。
クライアント専用の依存は `app/core/application/di/client.ts` に置き、
サーバー専用モジュールとは import 境界を分離する。

## Event Relay Worker example

```typescript
// app/core/application/workers/eventRelayWorker.ts (抜粋)

export async function processOutboxEvents(
  container: Container,
  dispatch: EventDispatcher,
  options: ProcessOutboxEventsOptions = {},
): Promise<{ processed: number }> {
  // 1) 未配信の行を atomic に claim。lease_token とリース期限がスタンプされる。
  const entries = await container.unitOfWorkProvider.run(
    ({ outboxRepository }) =>
      outboxRepository.claimPending(batchSize, leaseDurationMs, new Date()),
  );
  if (entries.length === 0) return { processed: 0 };

  // 2) dispatch。consumer は idempotent であること（at-least-once）。
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
  await container.unitOfWorkProvider.run(({ outboxRepository }) =>
    outboxRepository.markProcessed(dispatched),
  );
  return { processed: dispatched.length };
}
```

dispatcher 側で typed な payload を扱いたい場合は、ドメインごとの decode 関数
（`decodeTodoEvent` / `decodePostEvent`）を通してから consumer に渡す。
`schemaVersion` を見て互換分岐を書くのはこのレイヤー。
