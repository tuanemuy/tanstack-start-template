# Frontend Implementation Example

TanStack Start (React Server Components 有効) を前提とした実装例。

設計の基本姿勢:

- **RSC は "所有者" を意識して選ぶ。** RSC は `createServerFn` から返せる
  React Flight ペイロードに過ぎない。どこから呼ぶか = 誰がそのペイロードを
  持つか、を最初に決める。
- **データフェッチ・認可・ユースケース呼び出しはサーバーコンポーネント内で完結させる。**
  loader は「サーバーコンポーネントを RSC ペイロードとして取り込むための薄いプロキシ」として扱う。
- **エラーは `throw` する。** ステータスコードに変換して `data()` で返す必要は無い。
  `redirect({ to })` / `notFound()` を `throw` するとルーターが拾い、それ以外の例外は
  ルートの `errorComponent` にフォールバックする。
- **クライアントの状態が必要な箇所だけを `"use client"` で切り出す。** フォームや
  インタラクションを持つ部分のみクライアントコンポーネントにする。
- **クライアントから server function を呼ぶときは `useServerFn(fn)` でラップ。**
  これにより usecase 側で `throw redirect({ to })` した場合もルーター側が
  自動で navigate してくれる。

---

## RSC の所有者パターン

RSC は **Flight ペイロードを誰が保持・invalidate するか** で 4 通りの扱い方がある。
route loader だけが正解ではない。

### 1. Route loader が持つ (本テンプレのデフォルト)

URL に 1:1 で紐づくフラグメント。ルーターキャッシュが所有し、
`router.invalidate()` で再取得する。

```tsx
// app/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { TodoList } from "@/components/todo/TodoList";

const renderTodoList = createServerFn({ method: "GET" }).handler(async () => {
  const Rendered = await renderServerComponent(<TodoList />);
  return { Rendered };
});

export const Route = createFileRoute("/")({
  loader: async () => {
    const { Rendered } = await renderTodoList();
    return { TodoList: Rendered };
  },
  component: HomePage,
});

function HomePage() {
  const { TodoList } = Route.useLoaderData();
  return <>{TodoList}</>;
}
```

**選ぶ目安**: 一覧・詳細ページなど URL パラメータで一意に決まるフラグメント。

### 2. TanStack Query が持つ

route-shape ではないウィジェットや、独立して invalidate したい場合。
RSC 値を Query に入れるときは `structuralSharing: false` が必須。

```tsx
// app/routes/posts/$postId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  CompositeComponent,
  createCompositeComponent,
} from "@tanstack/react-start/rsc";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { z } from "zod";

const getPostRsc = createServerFn({ method: "GET" })
  .inputValidator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => {
    const post = await loadPost(data.postId);
    const src = await createCompositeComponent<{
      renderActions?: (args: { postId: string }) => ReactNode;
    }>((props) => (
      <article>
        <h1>{post.title}</h1>
        <footer>{props.renderActions?.({ postId: post.id })}</footer>
      </article>
    ));
    return { src };
  });

const postQueryOptions = (postId: string) => ({
  queryKey: ["post-rsc", postId],
  structuralSharing: false, // RSC 値を Query に入れるときは必須
  queryFn: () => getPostRsc({ data: { postId } }),
  staleTime: 5 * 60 * 1000,
});

export const Route = createFileRoute("/posts/$postId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(postQueryOptions(params.postId)),
  component: PostPage,
});

function PostPage() {
  const { postId } = Route.useParams();
  const { data } = useSuspenseQuery(postQueryOptions(postId));
  return <CompositeComponent src={data.src} />;
}
```

**選ぶ目安**: 複数ルートで使い回したい、背景で refetch したい、route 跨いで生き続けるウィジェット。

### 3. イベントハンドラで直接呼ぶ

ユーザー操作をトリガーに RSC をロードして state に積む。

```tsx
"use client";

import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getActivityFragment } from "./actions";

export function LoadMoreButton({ userId }: { userId: string }) {
  const loadFragment = useServerFn(getActivityFragment);
  const [fragment, setFragment] = useState<ReactNode>(null);

  return (
    <>
      <button
        type="button"
        onClick={async () => {
          const { Rendered } = await loadFragment({ data: { userId } });
          setFragment(Rendered);
        }}
      >
        もっと見る
      </button>
      {fragment}
    </>
  );
}
```

**選ぶ目安**: 初回ロードに含めたくない、ユーザー操作で段階的に取得したい場合。

### 4. Composite Component (クライアント slot 埋め込み)

サーバー描画マークアップの中にクライアント interactivity を差し込みたい場合に
使う。`children`、render prop、component prop の 3 種類の slot が使える。

```tsx
// server 側
import { createCompositeComponent } from "@tanstack/react-start/rsc";

const getPostCard = createServerFn({ method: "GET" })
  .inputValidator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => {
    const post = await loadPost(data.postId);
    const src = await createCompositeComponent<{
      renderActions?: (args: { postId: string }) => ReactNode;
    }>((props) => (
      <article>
        <h1>{post.title}</h1>
        <p>{post.body}</p>
        <footer>{props.renderActions?.({ postId: post.id })}</footer>
      </article>
    ));
    return { src };
  });
```

```tsx
// client 側
import { CompositeComponent } from "@tanstack/react-start/rsc";

<CompositeComponent
  src={src}
  renderActions={({ postId }) => <LikeButton postId={postId} />}
/>;
```

**選ぶ目安**: サーバー描画の中に「いいねボタン」のようなクライアント UI を差し込みたい。
`Children.map` / `cloneElement` でサーバー slot を覗きたくなったら、render prop に
変換する。

### 選択フロー

| 条件 | 選ぶの |
|---|---|
| URL に 1:1 で紐づく | **loader** |
| route 跨ぎで使う / 独立 invalidate | **Query** |
| 初回に含めたくない、ユーザー操作トリガ | **イベントハンドラ直呼び** |
| サーバーマークアップ内にクライアント UI を混ぜたい | **Composite Component** |

**悪いパターン**: 同じ RSC を loader と Query の両方で取得し、
片方だけ invalidate する "二重所有"。

---

## サーバーコンポーネント (データフェッチ込み)

サーバーコンポーネント自体が `async` 関数として `container` のユースケースを直接呼ぶ。
React の `cache()` で同一リクエスト内のデータ重複取得を抑える。

```tsx
// app/components/post/PostDetail.tsx (サーバーコンポーネント)

import { cache } from "react";
import { notFound, redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getContainer } from "@/core/application/di/server";
import { getPost } from "@/core/application/post/getPost";
import { isNotFoundError, isUnauthenticatedError } from "@/core/application/error";
import { RelatedPosts } from "./RelatedPosts";

// 同一リクエスト内で同じ postId を呼んでも 1 回だけフェッチする
const loadPost = cache(async (postId: string) => {
  const headers = getRequestHeaders();

  try {
    return await getPost({
      container: getContainer(),
      headers,
      input: { postId },
    });
  } catch (e) {
    if (isUnauthenticatedError(e)) throw redirect({ to: "/login" });
    if (isNotFoundError(e)) throw notFound();
    throw e;
  }
});

export async function PostDetail({ postId }: { postId: string }) {
  const { post } = await loadPost(postId);

  return (
    <article>
      <h1>{post.title}</h1>
      <p className="text-muted">by {post.authorName}</p>
      <div>{post.content}</div>

      {/* ネストしたサーバーコンポーネント — 内部で別のユースケースを await する */}
      <RelatedPosts postId={postId} />
    </article>
  );
}
```

### ポイント

- サーバーコンポーネント内で `await` しているので、loader でデータを揃える必要はない。
- 認証・存在チェック後の例外マッピングは `try/catch` + `throw redirect/notFound` で十分。
- 同一リクエスト内の重複呼び出しは `cache()` でメモ化する。
- DI コンテナは `@/core/application/di/server` の `getContainer()` を呼ぶ。ファイル冒頭に
  `import "@tanstack/react-start/server-only";` を入れてクライアント混入を防ぐ。

---

## ルート定義 (RSC を取り込む薄いプロキシ)

ルートの責務は「URL パラメータをサーバーコンポーネントに渡し、レンダリング結果を
RSC ペイロードとしてクライアントに送る」だけ。

```tsx
// app/routes/posts/$postId.tsx

import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";

import { PostDetail, getPostTitle } from "@/components/post/PostDetail";

const renderPostDetail = createServerFn({ method: "GET" })
  .inputValidator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => ({
    Detail: await renderServerComponent(<PostDetail postId={data.postId} />),
    title: await getPostTitle(data.postId),
  }));

export const Route = createFileRoute("/posts/$postId")({
  staleTime: 10_000,
  loader: ({ params }) => renderPostDetail({ data: { postId: params.postId } }),
  head: ({ loaderData }) =>
    loaderData ? { meta: [{ title: loaderData.title }] } : {},
  component: PostPage,
  errorComponent: ({ error }) => <div role="alert">エラー: {error.message}</div>,
  notFoundComponent: () => <div>記事が見つかりません</div>,
});

function PostPage() {
  const { Detail } = Route.useLoaderData();
  return Detail;
}
```

### ポイント

- loader は `renderServerComponent(<RSC />)` を呼ぶだけ。データフェッチはサーバーコンポーネント側。
- ナビゲーション後も `staleTime` が効くため、同じ URL に戻ったときにキャッシュを再利用できる。
- 強制再取得したいときはクライアント側で `useRouter().invalidate()`。
- 入力バリデーションは `.inputValidator(...)`。**旧 API の `.validator(...)` は使わない。**

---

## 共有サーバーロジック (認証ヘルパー)

複数のサーバーコンポーネント / サーバー関数で使う認証取得は関数として切り出して
`cache()` でメモ化する。

```typescript
// app/lib/server/currentUser.ts

import "@tanstack/react-start/server-only";

import { cache } from "react";
import { redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getContainer } from "@/core/application/di/server";
import type { User } from "@/core/domain/user/entity";

export const getCurrentUser = cache(async (): Promise<User | null> => {
  return getContainer().authProvider.getCurrentUser(getRequestHeaders());
});

export async function requireCurrentUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw redirect({ to: "/login" });
  return user;
}
```

サーバーコンポーネントやサーバー関数から `await requireCurrentUser()` を呼ぶだけで
認証チェックが済む。`createMiddleware` を使う代わりに、シンプルなヘルパーで揃える方が
RSC との相性が良い。

---

## Server Function (mutation)

state を変える操作は `createServerFn({ method: "POST" })` に集約し、
クライアントからは `useServerFn(fn)` 経由で呼ぶ。

```typescript
// app/components/todo/actions.ts

import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";

import { getContainer } from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ title: z.string().min(1).max(140) }))
  .handler(({ data }) =>
    createTodo({
      container: getContainer(),
      input: data,
    }),
  );
```

```tsx
// app/components/todo/CreateTodoForm.tsx
"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { type FormEvent, useState, useTransition } from "react";
import { createTodoFn } from "./actions";

export function CreateTodoForm() {
  const router = useRouter();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");
  const [isPending, startTransition] = useTransition();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    startTransition(async () => {
      await createTodo({ data: { title: title.trim() } });
      setTitle("");
      await router.invalidate();
    });
  };

  return (
    <form onSubmit={onSubmit}>
      <input
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        disabled={isPending}
        maxLength={140}
        required
      />
      <button type="submit" disabled={isPending}>追加</button>
    </form>
  );
}
```

### ポイント

- `useServerFn(fn)` は `isRedirect` を自動検知して router.navigate に変換する。
  usecase 側で `throw redirect({ to: "/login" })` した場合に client の try/catch
  でフォールスルーせずに済む。
- 完了後 `router.invalidate()` で loader データを再取得する。
- バリデーションエラーやドメインエラーを **フィールド単位で** UI に返したい場合は
  Conform + `parseWithZod` で onSubmit 側に寄せる。

---

## Conform によるクライアントバリデーション

Conform のクライアントバリデーション + `useServerFn` の組み合わせ例。

```tsx
// app/routes/posts/new.tsx
"use client";

import { useTransition } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  getFormProps,
  getInputProps,
  getTextareaProps,
  useForm,
} from "@conform-to/react";
import { getZodConstraint, parseWithZod } from "@conform-to/zod/v4";
import { toast } from "sonner";
import { createPostFn, createPostSchema } from "./actions";

export const Route = createFileRoute("/posts/new")({
  component: NewPostPage,
});

function NewPostPage() {
  const router = useRouter();
  const createPost = useServerFn(createPostFn);
  const [isPending, startTransition] = useTransition();

  const [form, fields] = useForm({
    id: "create-post",
    constraint: getZodConstraint(createPostSchema),
    shouldValidate: "onSubmit",
    shouldRevalidate: "onBlur",
    onValidate: ({ formData }) =>
      parseWithZod(formData, { schema: createPostSchema }),
    onSubmit: (event, { submission }) => {
      event.preventDefault();
      if (submission?.status !== "success") return;
      startTransition(async () => {
        try {
          const { postId } = await createPost({ data: submission.value });
          toast.success("投稿を作成しました");
          await router.navigate({
            to: "/posts/$postId",
            params: { postId },
          });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "作成に失敗しました");
        }
      });
    },
  });

  return (
    <form {...getFormProps(form)}>
      <div>
        <label htmlFor={fields.title.id}>タイトル</label>
        <input {...getInputProps(fields.title, { type: "text" })} />
        <div className="text-destructive">{fields.title.errors}</div>
      </div>

      <div>
        <label htmlFor={fields.content.id}>本文</label>
        <textarea {...getTextareaProps(fields.content)} />
        <div className="text-destructive">{fields.content.errors}</div>
      </div>

      <button type="submit" disabled={isPending}>
        {isPending ? "作成中..." : "作成"}
      </button>
    </form>
  );
}
```

---

## エラー / Not Found

ルート単位で `errorComponent` / `notFoundComponent` を定義する。サーバー
コンポーネント内で `throw` した例外はここにバブルアップする。

```tsx
export const Route = createFileRoute("/posts/$postId")({
  loader: ({ params }) => renderPostDetail({ data: { postId: params.postId } }),
  component: PostPage,
  errorComponent: ({ error }) => <ErrorView error={error} />,
  notFoundComponent: () => <NotFoundView />,
});
```

サイト全体の最終フォールバックは `app/routes/__root.tsx` の `errorComponent` /
`notFoundComponent` で受ける。

### Server Function の例外を構造化して伝搬する

`createServerFn` の `handler` が throw した例外はクライアントまで届くが、
`Error` のままだと `cause` チェーンや stack trace がシリアライズの過程で壊れ、
`kind` による分岐ができない。そこで application 層で

- `AppServerError` — 伝搬専用の例外クラス
- `serializeError(error)` — Business / NotFound / Validation 等を `SerializedError`（`{ kind, code, message }`）に畳み込む
- `extractSerializedError(error)` — クライアント側で `SerializedError` を取り出す
- `withErrorResponse(fn)` — handler をラップして上記を適用

を用意している。server function 側:

```typescript
// app/components/todo/actions.ts
import { withErrorResponse } from "@/core/application/errorResponse";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(z.object({ title: z.string().min(1).max(140) }))
  .handler(({ data }) =>
    withErrorResponse(() =>
      createTodo({ container: getContainer(), input: data }),
    ),
  );
```

クライアント側で kind に応じて UI を分岐する:

```tsx
import { extractSerializedError } from "@/core/application/errorResponse";

try {
  await deleteTodo({ data: { id } });
} catch (e) {
  const { kind, message } = extractSerializedError(e);
  if (kind === "notFound") setErrorMessage("このTodoは既に削除されています");
  else setErrorMessage(message);
}
```

---

## まとめ: 現行 `@tanstack/react-start` の必須事項

- Vite: `tanstackStart({ srcDirectory: "app", rsc: { enabled: true } })` +
  `rsc()` (`@vitejs/plugin-rsc`) + `viteReact()` の 3 枚構成
- server function バリデーション: **`.inputValidator(...)`**（`.validator(...)` は旧 API）
- RSC 高レベル API: `renderServerComponent` / `createCompositeComponent` / `CompositeComponent`
- server-only 境界: `import "@tanstack/react-start/server-only";` を DI コンテナや
  サーバーヘルパーの先頭に置く
- クライアントからの server function 呼び出し: **`useServerFn(fn)` でラップ**
  (redirect の自動ハンドル付き)
- RSC 値を Query に入れるときは `structuralSharing: false` 必須
- 低レベル API (`renderToReadableStream` / `createFromReadableStream` /
  `createFromFetch`) はカスタムトランスポートが必要なときだけ
