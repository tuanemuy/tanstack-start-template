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
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";

import { defineServerFn } from "@/core/presentation/serverFn";

const renderPostDetail = defineServerFn({ method: "GET" })
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

state を変える操作は `defineServerFn({ method: "POST" })` に集約する。
`defineServerFn` は `createServerFn` に `errorResponseMiddleware` を予め
適用したエントリポイントで、`inputValidator` と handler の **両方** の
throw を同じ middleware で拾って `AppServerError` envelope と HTTP ステータスに
変換する。 クライアントは `useServerFn(fn)` でラップしたうえで、React 19 の
**`useActionState` / `useTransition` / `useOptimistic`** に直接渡す。汎用フック
（`useServerAction` 風ラッパー）は意図的に用意しない — 第二の具体パターンが
出てきた時にだけ抽象化する。

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
// transport boundary 専用の `InputValidationError` をこのファイルに閉じて持つ。
// `@/lib/error` の `CodedError` を継承して `toSerialized()` で wire 化するので、
// 他のエラー（NotFound / Conflict / Business / System）と「class → toSerialized」
// プロトコルが揃う。application/domain の runtime は引かないので inputValidator が
// 走る client バンドルにも安全に乗る。
import { type z, type ZodType } from "zod";
import { CodedError, type FieldErrors } from "@/lib/error";
import {
  AppServerError,
  type SerializedValidationError,
} from "./errorResponse";

class InputValidationError extends CodedError {
  override readonly name = "InputValidationError";

  constructor(public readonly fieldErrors: FieldErrors) {
    super("INVALID_INPUT", "Invalid input");
  }

  override toSerialized(): SerializedValidationError {
    return {
      kind: "validation",
      code: this.code,
      message: this.message,
      retryable: false,
      fieldErrors: this.fieldErrors,
    };
  }
}

export function validateInput<T extends ZodType>(schema: T) {
  return (input: unknown): z.infer<T> => {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
    const error = new InputValidationError(
      zodIssuesToFieldErrors(parsed.error.issues),
    );
    throw new AppServerError(error.toSerialized());
  };
}
```

```typescript
// app/components/todo/actions.ts
import { getContainer } from "@/core/application/di/server";
import { createTodo } from "@/core/application/todo/createTodo";
import { defineServerFn } from "@/core/presentation/serverFn";
import { validateInput } from "@/core/presentation/validator";
import { createTodoSchema } from "./schema";

export const createTodoFn = defineServerFn({ method: "POST" })
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) =>
    createTodo({ container: await getContainer(), input: data }),
  );
```

### フォーム送信は `useActionState`

`<form action={formAction}>` + `useActionState` が React 19 の正攻法。
state には `SerializedError | null` を畳み、`validation` エラーなら
`fieldErrors` をそのまま field 単位で出す。

```tsx
// app/components/todo/CreateTodoForm.tsx
"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useState } from "react";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/core/presentation/errorResponse";
import { createTodoFn } from "./actions";
import { TODO_TITLE_MAX_LENGTH } from "./schema";

type FormState = { error: SerializedError | null };
const initialState: FormState = { error: null };

export function CreateTodoForm() {
  const router = useRouter();
  const createTodo = useServerFn(createTodoFn);
  const [title, setTitle] = useState("");

  const [state, formAction, isPending] = useActionState<FormState, FormData>(
    async (_prev, formData) => {
      const value = String(formData.get("title") ?? "").trim();
      if (value.length === 0) return { error: null };
      try {
        await createTodo({ data: { title: value } });
        await router.invalidate();
        setTitle("");
        return { error: null };
      } catch (error) {
        return { error: extractSerializedError(error) };
      }
    },
    initialState,
  );

  const titleFieldErrors =
    state.error?.kind === "validation"
      ? state.error.fieldErrors?.title
      : undefined;
  const summary =
    state.error !== null && titleFieldErrors === undefined
      ? displayError(state.error)
      : null;

  return (
    <form action={formAction}>
      <label>
        タイトル
        <input
          name="title"
          type="text"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
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

### 行内アクションは `useTransition` + `useOptimistic`

リスト中のチェックボックストグルや削除ボタンのような **フォーム外の即時
アクション** は、`useTransition` で transition を取りつつ、状態が即時反映
されるべき項目には `useOptimistic` を被せる。`useOptimistic` の setter は
**transition 内** から呼ぶことが必要条件。

```tsx
// app/components/todo/TodoItem.tsx
"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import type { TodoView } from "@/core/application/todo/view";
import { displayError } from "@/core/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/core/presentation/errorResponse";
import { changeTodoStatusFn, deleteTodoFn } from "./actions";

function todoErrorMessage(error: SerializedError): string {
  if (error.kind === "notFound") return "このTodoは既に削除されています";
  return displayError(error);
}

export function TodoItem({ todo }: { todo: TodoView }) {
  const router = useRouter();
  const changeStatus = useServerFn(changeTodoStatusFn);
  const remove = useServerFn(deleteTodoFn);

  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<SerializedError | null>(null);
  const [optimisticCompleted, setOptimisticCompleted] = useOptimistic(
    todo.status === "completed",
    (_current, next: boolean) => next,
  );

  const onToggle = (checked: boolean) => {
    startTransition(async () => {
      setOptimisticCompleted(checked);
      try {
        await changeStatus({
          data: { id: todo.id, status: checked ? "completed" : "active" },
        });
        await router.invalidate();
        setError(null);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  const onDelete = () => {
    startTransition(async () => {
      try {
        await remove({ data: { id: todo.id } });
        await router.invalidate();
        setError(null);
      } catch (e) {
        setError(extractSerializedError(e));
      }
    });
  };

  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={optimisticCompleted}
          onChange={(e) => onToggle(e.target.checked)}
          disabled={isPending}
        />
        <span style={{ textDecoration: optimisticCompleted ? "line-through" : "none" }}>
          {todo.title}
        </span>
      </label>
      <button type="button" onClick={onDelete} disabled={isPending}>削除</button>
      {error !== null ? <span role="alert">{todoErrorMessage(error)}</span> : null}
    </li>
  );
}
```

### Conflict などの失敗

`ConflictError` などの失敗もエンベロープに乗ってクライアントに伝播する。
UI 側は action / transition の `catch` で `extractSerializedError(e)` し、
`error.kind` で switch する：

```tsx
try {
  await changeStatus({ data: { id, status } });
} catch (e) {
  const error = extractSerializedError(e);
  if (error.kind === "notFound") setMessage("このTodoは既に削除されています");
  else if (error.kind === "conflict") setMessage("他の操作と競合しました。もう一度お試しください");
  else setMessage(displayError(error));
}
```

### ポイント

- `useServerFn(fn)` は `isRedirect` を自動検知して router.navigate に変換する。
  usecase 側で `throw redirect({ to: "/login" })` した場合に client の try/catch
  でフォールスルーせずに済む。
- `useActionState` の action は async でよい。`await` の前後どちらの状態
  更新も同じ transition に入る。`<form action={formAction}>` に渡せば JS が
  まだ届いていないクライアントでも progressively enhance できる。
- 成功時に loader 所有の RSC を更新したいときは action / transition 内で
  `await router.invalidate()` を明示する。汎用フックを廃したぶん「いつ
  invalidate するか」は呼び出し側の責任。
- `fieldErrors` を **フィールド単位で** 表示したい場合は `state.error?.kind === "validation"`
  を分岐するだけ。Conform + `parseWithZod` を別途導入しなくてもこの形で足りる。
  検証は server 側の Zod に一本化されているので、どの入口（server function / route
  loader / テスト）から呼んでも同一の `ValidationError` envelope で届く。
- `useOptimistic` は **親が所有しているデータ** に対しては使えない。
  `TodoItem` が自身の `completed` をトグルするのには使えるが、リストから
  項目を消すような **親の state を変える操作** は `router.invalidate()` で
  RSC を再取得する経路に任せる（このテンプレでは削除がそれに該当）。

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
- `errorResponseMiddleware`（`app/core/presentation/errorResponseMiddleware.ts`） — server function 全体（`inputValidator` と handler の両方）をラップして上記を適用し、`SerializedErrorKind` から HTTP ステータスを設定する。TanStack Router の `redirect()` / `notFound()` センチネルはそのまま rethrow
- `defineServerFn(opts?)`（`app/core/presentation/serverFn.ts`） — `createServerFn(opts).middleware([errorResponseMiddleware])` を返す canonical エントリポイント。`createServerFn` を直接呼ばずこちらを使う

を用意している（`app/core/presentation/errorResponse.ts`）。

クライアントの action / transition / loader などで生で `await` する側は
`extractSerializedError` で kind に分岐する：

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
