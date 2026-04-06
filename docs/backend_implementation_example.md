# Example Implementation

## Entities example

```typescript
// app/core/domain/post/entity.ts

import type { UserId } from "@/core/domain/user/valueObject";
import type { WithEvents } from "@/core/domain/common/event";
import { PostId, PostContent } from "./valueObject";
import type { PostId as PostIdType, PostContent as PostContentType } from "./valueObject";
import { PostEvents, type PostEvent } from "./events";

// Post型定義
type PostBase = Readonly<{
  id: PostIdType;
  userId: UserId;
  content: PostContentType;
  createdAt: Date;
  updatedAt: Date;
}>;

type DraftPost = PostBase & {
  readonly status: "draft";
};

type PublishedPost = PostBase & {
  readonly status: "published";
};

type Post = DraftPost | PublishedPost;

export type { Post, DraftPost, PublishedPost };

// Postモジュール（振る舞いをまとめる）
export const Post = {
  // ファクトリーメソッド
  create: (params: { userId: UserId; content: string }): WithEvents<DraftPost, PostEvent> => {
    const now = new Date();
    const post: DraftPost = {
      id: PostId.generate(),
      userId: params.userId,
      content: PostContent.create(params.content),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    return {
      entity: post,
      events: [PostEvents.created(post.id, params.userId)],
    };
  },

  // 振る舞い
  updateContent: (post: Post, newContent: string): WithEvents<Post, PostEvent> => {
    return {
      entity: {
        ...post,
        content: PostContent.create(newContent),
        updatedAt: new Date(),
      },
      // イベントが発生しない場合は空配列
      events: [],
    };
  },

  // 振る舞い
  publish: (post: DraftPost): WithEvents<PublishedPost, PostEvent> => {
    return {
      entity: {
        ...post,
        status: "published",
        updatedAt: new Date(),
      },
      events: [PostEvents.published(post.id)],
    };
  },

  // 型ガード
  isDraft: (post: Post): post is DraftPost => post.status === "draft",
  isPublished: (post: Post): post is PublishedPost => post.status === "published",
};
```

## Value Objects example

```typescript
// app/core/domain/post/valueObject.ts

import { v7 as uuidv7 } from "uuid";
import { BusinessRuleError } from "@/core/domain/error";
import { PostErrorCode } from "./errorCode";

const POST_CONTENT_MAX_LENGTH = 5000;

// PostId
type PostId = string & { readonly brand: "PostId" };

export type { PostId };

export const PostId = {
  create: (id: string): PostId => {
    // Add validation if necessary
    return id as PostId;
  },
  generate: (): PostId => {
    return uuidv7() as PostId;
  },
};

// PostContent
type PostContent = string & { readonly brand: "PostContent" };

export type { PostContent };

export const PostContent = {
  create: (content: string): PostContent => {
    if (content.length === 0) {
      throw new BusinessRuleError(PostErrorCode.ContentEmpty, "Post content cannot be empty");
    }
    if (content.length > POST_CONTENT_MAX_LENGTH) {
      throw new BusinessRuleError(PostErrorCode.ContentTooLong, "Post content exceeds maximum length");
    }
    return content as PostContent;
  },
  maxLength: POST_CONTENT_MAX_LENGTH,
};

// PostStatus
type PostStatus = "draft" | "published";

export type { PostStatus };

export const PostStatus = {
  create: (status: string): PostStatus => {
    if (status !== "draft" && status !== "published") {
      throw new BusinessRuleError(PostErrorCode.InvalidStatus, "Invalid post status");
    }
    return status as PostStatus;
  },
  isDraft: (status: PostStatus): status is "draft" => status === "draft",
  isPublished: (status: PostStatus): status is "published" => status === "published",
};

// Other value objects...
```

## Domain Events example

```typescript
// app/core/domain/post/events.ts

import type { PostId } from "./valueObject";
import type { UserId } from "@/core/domain/user/valueObject";
import type { DomainEventBase } from "@/core/domain/common/event";

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
    type: "post.created",
    payload: { postId, userId },
    occurredAt: new Date(),
  }),

  published: (postId: PostId): PostPublishedEvent => ({
    type: "post.published",
    payload: { postId },
    occurredAt: new Date(),
  }),
};
```

## Ports example

```typescript
// app/core/domain/post/ports/postRepository.ts

import type { RepositoryError } from "@/core/error/adapter";
import type { Pagination, PaginationResult } from "@/core/domain/common/pagination";
import type { Post } from "@/core/domain/post/entity";
import type { UserId } from "@/core/domain/user/valueObject";

export interface PostRepository {
  save(post: Post): Promise<void>;
  findByUserId(userId: UserId, pagination: Pagination): Promise<PaginationResult<Post>>;
  // Other repository methods...
}
```

```typescript
// app/core/domain/file/ports/storageManager.ts

export interface StorageManager {
  uploadFile(/* Arguments */): Promise</* ReturnType */>;
  // Other storage management methods...
}
```

```typescript
// app/core/domain/common/ports/outboxRepository.ts

import type { DomainEvent } from "@/core/domain/common/event";

export interface OutboxRepository {
  saveEvents(events: DomainEvent[]): Promise<void>;
  findPendingEvents(limit: number): Promise<OutboxEntry[]>;
  markAsProcessed(id: string): Promise<void>;
}
```

## Adapters example

```typescript
// app/core/adapters/drizzleSqlite/postRepository.ts

import type { InferSelectModel } from "drizzle-orm";
import type { Pagination, PaginationResult } from "@/lib/pagination";
import { SystemError, SystemErrorCode } from "@/core/application/error";
import { BusinessRuleError } from "@/core/domain/error";
import type { UserId } from "@/core/domain/user/valueObject";
import type { Post } from "@/core/domain/post/entity";
import type { PostId, PostContent, PostStatus } from "@/core/domain/post/valueObject";
import type { PostRepository } from "@/core/domain/post/ports/postRepository";
import { posts } from "@/core/adapters/drizzleSqlite/schema";
import type { Executor } from "./database";

type PostDataModel = InferSelectModel<typeof posts>;

export class DrizzleSqlitePostRepository implements PostRepository {
  constructor(
    private readonly executor: Executor) {}

  into(data: PostDataModel): Post {
    return {
      id: data.id as PostId,
      userId: data.userId as UserId,
      content: data.content as PostContent,
      status: data.status as PostStatus,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  }

  async save(post: Post): Promise<void> {
    try {
      await this.executor
        .insert(posts)
        .values(post)
        .onConflictDoUpdate({
          target: posts.id,
          set: {
            userId: post.userId,
            content: post.content,
            status: post.status,
          },
        });
    } catch (error) {
      // Handle errors, possibly mapping database errors to specific errors or codes
      throw new SystemError(SystemErrorCode.DatabaseError, "Failed to save post", error);
    }
  }

  async findByUserId(userId: UserId, pagination: Pagination): Promise<PaginationResult<Post>> {
    const limit = pagination.limit;
    const offset = (pagination.page - 1) * pagination.limit;

    try {
      const [items, countResult] = await Promise.all([
        this.executor
          .select()
          .from(posts)
          .where(eq(posts.userId, userId))
          .limit(limit)
          .offset(offset),
        this.executor
          .select({ count: sql`count(*)` })
          .from(posts)
          .where(eq(posts.userId, userId)),
      ]);

      return {
        items: items.map((item) => this.into(item)),
        count: Number(countResult[0].count),
      };
    } catch (error) {
      // Handle errors, possibly mapping database errors to specific errors or codes
      throw new SystemError(SystemErrorCode.DatabaseError, "Failed to find posts", error);
    }
  }
}
```

## Database schema example

```typescript
// app/core/adapters/drizzleSqlite/schema.ts

import { v7 as uuidv7 } from "uuid";

export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    // Other fields...
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
);
```

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

```typescript
// app/core/application/post/createPost.ts

import { Post } from "@/core/domain/post/entity";
import type { DraftPost } from "@/core/domain/post/entity";
import type { Container } from "../di/server";
import type { ServiceArgs } from "../types";
import {
  UnauthenticatedError,
  UnauthenticatedErrorCode,
} from "../error";
import { PostDetail } from "./dto";

export type CreatePostInput = {
  // Primitive types for input DTOs
  content: string;
};

// Pass arguments as an object
export async function createPost({
  container,
  input
}: ServiceArgs<CreatePostInput>): Promise<DraftPost> {
  const userId = container.authProvider.getUserId(); // or get current user

  if (!userId) {
    throw new UnauthenticatedError(UnauthenticatedErrorCode.AuthenticationRequired, "Authentication required");
  }

  const { entity: post, events } = Post.create({
    userId,
    content: input.content,
  });

  // Outboxパターン: エンティティ変更とイベント保存を同一トランザクションで実行
  await container.unitOfWork.run(async (repositories) => {
    await repositories.postRepository.save(post);
    await repositories.outboxRepository.saveEvents(events);
  });

  // イベント配信は別プロセス（EventRelayWorker）が担当

  return {
    post: {
      id: result.result.post.id,
      title: result.result.post.title,
      content: result.result.post.content,
      authorName: currentUser.name,
      createdAt: result.result.post.createdAt,
    },
  };
}
```

## DI Container example

```typescript
// DI Container for specific environment
// ex: app/di.ts

import type { Container } from "@/core/application/container";
import { getDatabase } from "@/core/adapters/drizzleSqlite/client";

export function createContainer(): Container {
  const databaseUrl = process.env.SQLITE_URL;
  if (!databaseUrl) {
    throw new Error("SQLITE_URL is not set");
  }

  const db = getDatabase(databaseUrl);

  export const container = {
    unitOfWorkProvider: DrizzleSqliteUnitOfWorkProvider(db),
    authProvider: new BetterAuthAuthProvider(/* Config */),
    storageManager: new S3StorageManager(/* S3 client */),
    // Other adapters...
  };
}

export const container = createContainer();
```

## Event Relay Worker example

```typescript
// app/core/application/workers/eventRelayWorker.ts

// 別プロセスでOutboxからイベントを取得し配信
export async function processOutboxEvents(container: Container): Promise<void> {
  const entries = await container.outboxRepository.findPendingEvents(100);

  for (const entry of entries) {
    await container.eventDispatcher.dispatch(entry.event);
    await container.outboxRepository.markAsProcessed(entry.id);
  }
}
```
