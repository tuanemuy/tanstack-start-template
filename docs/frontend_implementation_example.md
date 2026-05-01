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
import { sanitizeRouteError } from "@/core/presentation/errorDisplay";

const loadTodoListRouteData = createServerFn({ method: "GET" }).handler(
  async () => {
    const { TodoList } = await import("@/components/todo/TodoList");
    const Rendered = await renderServerComponent(<TodoList />);
    return { TodoList: Rendered };
  },
);

export const Route = createFileRoute("/")({
  // staleTime: 0 なら毎回 loader を回し直して最新 RSC を取る。TodoList が
  // 内部で `cache()` しているので同一ナビゲーション内の重複 fetch はない。
  staleTime: 0,
  loader: () => loadTodoListRouteData(),
  component: HomePage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function HomePage() {
  const { TodoList } = Route.useLoaderData();
  return <>{TodoList}</>;
}
```

route ファイルは client graph にも入るため、server-only な DI や server
component を静的 import しない。`createServerFn` / `.server.ts` 側へ閉じ込め、
loader はその bridge を呼ぶだけにする。

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

> **現状**: このテンプレートでは採用していない。Todo の UI は loader +
> 通常の `"use client"` コンポーネントで完結するため不要。将来サーバー描画
> マークアップの中にクライアント interactivity を差し込む必要が出たときの
> 参考パターンとして残している。

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
import { isNotFoundError } from "@/core/application/errors";
import { RelatedPosts } from "./RelatedPosts";

// 同一リクエスト内で同じ postId を呼んでも 1 回だけフェッチする。
// `cache()` は引数でキャッシュキーを作るので、`loadPost("a")` と
// `loadPost("b")` は別キャッシュとして独立して評価される。異なる引数で
// 呼ぶほど dedupe は効かず、引数を全く取らない関数でも `cache(() => ...)`
// してから関数参照経由で呼ばないと dedupe されない点に注意。
const loadPost = cache(async (postId: string) => {
  const headers = getRequestHeaders();

  try {
    return await getPost({
      container: await getContainer(),
      headers,
      input: { postId },
    });
  } catch (e) {
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
- **`cache()` の dedupe スコープは同一リクエスト + 同一引数**。`loadPost(id)` を
  同一 RSC ツリー内で複数回呼んでも実行は 1 回、異なる `id` は別キャッシュで独立評価。
  引数を取らない loader は `cache(async () => ...)` で包んだうえで **同じ関数参照**
  経由で呼ぶ（例: `app/components/todo/TodoList.tsx` の `loadTodos()`）。
- DI コンテナは `@/core/application/di/server` の `getContainer()` を呼ぶ。ファイル冒頭に
  `import "@tanstack/react-start/server-only";` を入れてクライアント混入を防ぐ。
- `getContainer()` は `Promise<Container>` を返すので `await` が必要。

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

const renderPostDetail = createServerFn({ method: "GET" })
  .inputValidator(z.object({ postId: z.string() }))
  .handler(async ({ data }) => {
    const { PostDetail, getPostTitle } = await import(
      "@/components/post/PostDetail"
    );
    return {
      Detail: await renderServerComponent(<PostDetail postId={data.postId} />),
      title: await getPostTitle(data.postId),
    };
  });

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

- loader は server function bridge を呼ぶだけ。`renderServerComponent(<RSC />)` と
  server-only import は bridge の handler 側に閉じ込める。
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
  const container = await getContainer();
  return container.authProvider.getCurrentUser(getRequestHeaders());
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

state を変える操作は `createServerFn({ method: "POST" })` に集約し、例外は
`withErrorResponse(fn)` で `AppServerError` にラップしてクライアントまで
届ける。クライアントは `useServerFn(fn)` と `useServerAction` を組み合わせる。

### 入力検証の責務分担

入力検証は **2 箇所だけ** で行う。usecase は介在しない。

| 層 | 責務 |
|---|---|
| Transport boundary (`inputValidator`) | shape / DoS チェック。JSON が期待シグネチャと噛み合うかだけ |
| Domain VO factory (`TodoTitle.create` 等) | 業務 invariant の最終ゲート |

usecase は input の **静的型を信頼してドメインロジックの適用に専念** する。
VO factory が `BusinessRuleError` を throw すると、そのまま envelope
（`{ kind: "business" }`）でクライアントに届く。

なぜ usecase で Zod を走らせないか:

- VO factory が同じ制約を再検証するので二重になる。
- 検証を usecase に置くと、Zod / domain modules が application 層に
  混ざり、CLAUDE.md の依存方向（application → domain）と摩擦する。
- shape チェックは transport の責務。型として届いた以上 usecase は
  信頼してよい。

`createServerFn` の `inputValidator` は client/server 両方で走るので、
そこから static import される schema は **`@/core/domain/*` や
`@/core/application/*` を一切引いてはいけない**。schema は presentation
独立で `app/components/${domain}/schema.ts` に置く。

```typescript
// app/components/todo/schema.ts
import { z } from "zod";

export const TODO_TITLE_MAX_LENGTH = 140;

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});
```

```typescript
// app/core/presentation/validator.ts
// 構造のみを担う `@/lib/error` と sibling の `./errorResponse` から
// 型だけ引いてくる（runtime はすでに client バンドルに乗っている presentation 層）。
// application/domain の runtime は引きずり込まないので inputValidator が走る
// client バンドルにも安全に乗る。
import { type z, type ZodType } from "zod";
import type { FieldErrors } from "@/lib/error";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

export function validateInput<T extends ZodType>(schema: T) {
  return (input: unknown): z.infer<T> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const serialized: SerializedValidationError = {
      kind: "validation",
      code: "INVALID_INPUT",
      message: "Invalid input",
      retryable: false,
      fieldErrors: zodIssuesToFieldErrors(parsed.error.issues),
    };
    throw new AppServerError(serialized);
  };
}
```

```typescript
// app/components/todo/actions.ts
import { createServerFn } from "@tanstack/react-start";
import { getContainer } from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";
import { withErrorResponse } from "@/core/presentation/errorResponse.server";
import { validateInput } from "@/core/presentation/validator";
import { createTodoSchema } from "./schema";

export const createTodoFn = createServerFn({ method: "POST" })
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) =>
    withErrorResponse(async () =>
      createTodo({ container: await getContainer(), input: data }),
    ),
  );
```

### useServerAction で呼ぶ

`useServerAction(fn, options)` は server function 呼び出しに **router
invalidation + transition + エラー kind 分岐** を一枚で被せるフック。戻り
値の `lastError: SerializedError | null` を使うと、`validation` エラーの
`fieldErrors` をそのまま UI に流し込める。

```tsx
// app/components/todo/CreateTodoForm.tsx
"use client";

import { useServerFn } from "@tanstack/react-start";
import { type SubmitEvent, useState } from "react";
import { displayError } from "@/core/presentation/errorDisplay";
import { useServerAction } from "@/core/presentation/useServerAction";
import { createTodoFn } from "./actions";
import { TODO_TITLE_MAX_LENGTH } from "./schema";

export function CreateTodoForm() {
  const [title, setTitle] = useState("");

  const { run, isPending, lastError, clearLastError } = useServerAction(
    useServerFn(createTodoFn),
    {
      // invalidate: "all"（デフォルト）なので onSuccess 後に router.invalidate()
      // が走る。部分 invalidate したいときは `() => router.invalidate({ filter })`。
      onSuccess: () => setTitle(""),
    },
  );

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    run({ data: { title: value } });
  };

  // ValidationError.fieldErrors があれば field 単位で、それ以外は
  // displayError で集約メッセージを表示する。
  const titleFieldErrors =
    lastError?.kind === "validation" ? lastError.fieldErrors?.title : undefined;
  const summary =
    lastError !== null && titleFieldErrors === undefined
      ? displayError(lastError)
      : null;

  return (
    <form onSubmit={onSubmit}>
      <label>
        タイトル
        <input
          type="text"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            if (lastError) clearLastError();
          }}
          disabled={isPending}
          maxLength={TODO_TITLE_MAX_LENGTH}
          required
          aria-invalid={titleFieldErrors !== undefined}
        />
      </label>
      {titleFieldErrors?.[0] ? (
        <p role="alert">{titleFieldErrors[0]}</p>
      ) : null}
      <button type="submit" disabled={isPending || title.trim().length === 0}>
        {isPending ? "作成中..." : "追加"}
      </button>
      {summary ? <p role="alert">{summary}</p> : null}
    </form>
  );
}
```

### Conflict などの失敗

`ConflictError` 等の失敗はそのままクライアントに伝播する。UI は
`onError` の `conflict` ハンドラで「再試行してください」と表示するか、
`useServerAction` を呼び直す。

```tsx
const changeStatus = useServerAction(useServerFn(changeTodoStatusFn), {
  onError: {
    notFound: () => setErrorMessage("このTodoは既に削除されています"),
    conflict: () => setErrorMessage("他の操作と競合しました。もう一度お試しください"),
    default: (error) => setErrorMessage(displayError(error)),
  },
});
```

### ポイント

- `useServerFn(fn)` は `isRedirect` を自動検知して router.navigate に変換する。
  usecase 側で `throw redirect({ to: "/login" })` した場合に client の try/catch
  でフォールスルーせずに済む。
- `invalidate` は `"all"` / `"none"` / `() => void | Promise<void>` の 3 択。
  デフォルトは `"all"` なので全 loader が refetch される。
- `lastError` / `clearLastError` で UI 側のエラー state を hook が管理するため、
  フォームコンポーネント内に `useState<string | null>` を用意しなくて済む。
- `fieldErrors` を **フィールド単位で** 表示したい場合は `lastError?.kind === "validation"`
  を分岐するだけ。Conform + `parseWithZod` を別途導入しなくてもこの形で足りる。
  検証は usecase 内の Zod に一本化されているので、どの入口（server function / route
  loader / テスト）から呼んでも同一の `ValidationError` envelope で届く。

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
// app/routes/index.tsx
export const Route = createFileRoute("/")({
  loader: async () => { /* ... */ },
  component: HomePage,
  // 子ルートで catch されなかった例外は __root.tsx の errorComponent に
  // バブルアップする。子側で定義された errorComponent があればそこで止まる。
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>エラーが発生しました</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});
```

サイト全体の最終フォールバックは `app/routes/__root.tsx` の `errorComponent`
/ `notFoundComponent`。階層関係は以下：

```
例外発生源（loader / server component / server function）
    ↓ throw
マッチした子ルート .errorComponent  ←  ここで定義していれば止まる
    ↓ 未定義なら bubble up
__root.tsx .errorComponent          ←  最終フォールバック（sanitizeRouteError）
```

`redirect()` / `notFound()` は errorComponent ではなく router 自身が捕捉し、
それぞれナビゲーション / `notFoundComponent` に振り分ける。

### Server Function の例外を構造化して伝搬する

`createServerFn` の `handler` が throw した例外はクライアントまで届くが、
`Error` のままだと `cause` チェーンや stack trace がシリアライズの過程で壊れ、
`kind` による分岐ができない。そこで presentation 層で

- `AppServerError` — 伝搬専用の例外クラス（`serialized` を enumerable own property に持ち、JSON 往復後も生き残る）
- `serializeError(error)` — Business / NotFound / Validation 等を `SerializedError`（`{ kind, code, message, retryable?, fieldErrors? }`）に畳み込む
- `extractSerializedError(error)` — クライアント側で `SerializedError` を取り出す（`AppServerError` でも、plain object 化された残骸でも動く）
- `withErrorResponse(fn)` — handler をラップして上記を適用。TanStack Router の `redirect()` / `notFound()` センチネルはそのまま rethrow

を用意している（`app/core/presentation/errorResponse.ts`）。

`useServerAction` を通さず生で `await` したい場合は `extractSerializedError`
で kind に分岐する：

```tsx
import { extractSerializedError } from "@/core/presentation/errorResponse";

try {
  await deleteTodo({ data: { id } });
} catch (e) {
  const { kind, message } = extractSerializedError(e);
  if (kind === "notFound") setErrorMessage("このTodoは既に削除されています");
  else setErrorMessage(message);
}
```

`displayError` / `sanitizeRouteError` は `Record<SerializedErrorKind, handler>`
型のテーブルでディスパッチしているので、`SerializedError.kind` に新しい variant
を足すとコンパイルエラーになる。網羅性を型で担保するのが狙い。

---

## まとめ: 現行 `@tanstack/react-start` の必須事項

- Vite: `tanstackStart({ srcDirectory: "app", rsc: { enabled: true } })` +
  `rsc()` (`@vitejs/plugin-rsc`) + `viteReact()` の 3 枚構成
- server function バリデーション: **`.inputValidator(...)`**（`.validator(...)` は旧 API）
- RSC 高レベル API: `renderServerComponent` / `createCompositeComponent` / `CompositeComponent`
- server-only 境界: `import "@tanstack/react-start/server-only";` は DI コンテナや
  サーバーヘルパーの先頭に置く。client component が import する server function
  定義ファイルには置かず、handler 内の dynamic import で server-only 側へ入る
- クライアントからの server function 呼び出し: **`useServerFn(fn)` でラップ**
  (redirect の自動ハンドル付き)
- RSC 値を Query に入れるときは `structuralSharing: false` 必須
- 低レベル API (`renderToReadableStream` / `createFromReadableStream` /
  `createFromFetch`) はカスタムトランスポートが必要なときだけ
