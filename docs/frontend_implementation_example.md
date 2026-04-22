# Frontend Implementation Example

TanStack Start (React Server Components 有効) を前提とした実装例。

設計の基本姿勢:

- **データフェッチ・認可・ユースケース呼び出しはサーバーコンポーネント内で完結させる。**
  loader はあくまで「サーバーコンポーネントを RSC ペイロードとして取り込むための薄いプロキシ」として扱う。
- **エラーは `throw` する。** ステータスコードに変換して `data()` で返す必要は無い。
  `redirect({ to })` / `notFound()` を `throw` するとルーターが拾い、それ以外の例外は
  ルートの `errorComponent` にフォールバックする。
- **クライアントの状態が必要な箇所だけを `"use client"` で切り出す。** フォームや
  インタラクションを持つ部分のみクライアントコンポーネントにする。

---

## サーバーコンポーネント (データフェッチ込み)

サーバーコンポーネント自体が `async` 関数として `container` のユースケースを直接呼ぶ。
React の `cache()` で同一リクエスト内のデータ重複取得を抑える。

```tsx
// app/components/post/PostDetail.tsx (サーバーコンポーネント)

import { cache } from "react";
import { notFound, redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { container } from "@/core/di/server";
import { getPost } from "@/core/application/post/getPost";
import { isNotFoundError, isUnauthenticatedError } from "@/core/application/error";
import { RelatedPosts } from "./RelatedPosts";

// 同一リクエスト内で同じ postId を呼んでも 1 回だけフェッチする
const loadPost = cache(async (postId: string) => {
  const headers = getRequestHeaders();

  try {
    return await getPost({
      container,
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

// head 情報を loader 側で使いたい場合は、cache 化しているので二重フェッチにならない
export async function getPostTitle(postId: string): Promise<string> {
  const { post } = await loadPost(postId);
  return post.title;
}
```

```tsx
// app/components/post/RelatedPosts.tsx (サーバーコンポーネント)

import { getRequestHeaders } from "@tanstack/react-start/server";
import { container } from "@/core/di/server";
import { listRelatedPosts } from "@/core/application/post/listRelatedPosts";

export async function RelatedPosts({ postId }: { postId: string }) {
  const headers = getRequestHeaders();
  const { posts } = await listRelatedPosts({
    container,
    headers,
    input: { postId, limit: 5 },
  });

  if (posts.length === 0) return null;

  return (
    <section>
      <h2>関連記事</h2>
      <ul>
        {posts.map((post) => (
          <li key={post.id}>{post.title}</li>
        ))}
      </ul>
    </section>
  );
}
```

### ポイント

- サーバーコンポーネント内で `await` しているので、loader でデータを揃える必要はない。
- 認証・存在チェック後の例外マッピングは `try/catch` + `throw redirect/notFound` で十分。
  `handleUseCase` のような正規化ヘルパーは不要。
- 同一リクエスト内の重複呼び出しは `cache()` でメモ化する（fetch deduping）。

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

---

## 共有サーバーロジック (認証ヘルパー)

複数のサーバーコンポーネント / サーバー関数で使う認証取得は関数として切り出して
`cache()` でメモ化する。

```typescript
// app/lib/server/currentUser.ts

import { cache } from "react";
import { redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { container } from "@/core/di/server";
import type { User } from "@/core/domain/user/entity";

export const getCurrentUser = cache(async (): Promise<User | null> => {
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

## 単一フォーム (Conform + createServerFn)

クライアントコンポーネントで Conform バリデーションし、`onSubmit` から `createServerFn`
を直接呼ぶ。エラーは server function 内で `throw` してそのままクライアントに伝える。

```tsx
// app/routes/posts/new.tsx
"use client";

import { useTransition } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  getFormProps,
  getInputProps,
  getTextareaProps,
  useForm,
} from "@conform-to/react";
import { getZodConstraint, parseWithZod } from "@conform-to/zod/v4";
import { toast } from "sonner";
import { z } from "zod";

import { container } from "@/core/di/server";
import { createPost } from "@/core/application/post/createPost";
import { requireCurrentUser } from "@/lib/server/currentUser";
import { getRequestHeaders } from "@tanstack/react-start/server";

const createPostSchema = z.object({
  title: z.string().min(1, "タイトルを入力してください"),
  content: z.string().min(1, "本文を入力してください"),
});

const createPostFn = createServerFn({ method: "POST" })
  .inputValidator(createPostSchema)
  .handler(async ({ data }) => {
    await requireCurrentUser();
    const { post } = await createPost({
      container,
      headers: getRequestHeaders(),
      input: data,
    });
    return { postId: post.id };
  });

export const Route = createFileRoute("/posts/new")({
  component: NewPostPage,
});

function NewPostPage() {
  const router = useRouter();
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
          const { postId } = await createPostFn({ data: submission.value });
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

## 複数 intent フォーム (Composite Action)

同一ページから複数のサーバー操作（プロフィール更新・パスワード変更など）を
扱いたい場合は intent ごとにハンドラを定義し、`createCompositeAction` で
ディスパッチする。フィールドエラーは `error()`、ビジネスエラーは `throw` でも
`error()` で返してもよい。

```tsx
// app/routes/settings/index.tsx
"use client";

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import {
  getFormProps,
  getInputProps,
  useForm,
} from "@conform-to/react";
import { getZodConstraint, parseWithZod } from "@conform-to/zod/v4";
import { toast } from "sonner";
import { z } from "zod";

import { container } from "@/core/di/server";
import { changePassword, updateProfile } from "@/core/application/user";
import { requireCurrentUser } from "@/lib/server/currentUser";
import {
  createCompositeAction,
  defineHandler,
  error,
  success,
  useCompositeAction,
} from "@/lib/compositeAction";
import { formatErrorMessage } from "@/lib/error";
import { isBusinessRuleError } from "@/core/domain/error";

const updateProfileSchema = z.object({
  name: z.string().min(1, "名前を入力してください"),
  email: z.email("有効なメールアドレスを入力してください"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "現在のパスワードを入力してください"),
  newPassword: z.string().min(8, "8文字以上で入力してください"),
});

export const handlers = {
  updateProfile: defineHandler({
    schema: updateProfileSchema,
    handler: async (value) => {
      await requireCurrentUser();
      const { user } = await updateProfile({
        container,
        headers: getRequestHeaders(),
        input: value,
      });
      return success({ user });
    },
  }),
  changePassword: defineHandler({
    schema: changePasswordSchema,
    handler: async (value) => {
      await requireCurrentUser();
      try {
        await changePassword({
          container,
          headers: getRequestHeaders(),
          input: value,
        });
        return success();
      } catch (e) {
        // ドメインルール違反だけはフィールドエラーに変換、それ以外は throw
        if (isBusinessRuleError(e)) {
          return error({ currentPassword: [formatErrorMessage(e)] });
        }
        throw e;
      }
    },
  }),
};

const settingsAction = createServerFn({ method: "POST" })
  .inputValidator((formData: FormData) => formData)
  .handler(({ data }) => createCompositeAction(data, handlers));

export const Route = createFileRoute("/settings/")({
  component: SettingsPage,
});

function SettingsPage() {
  const router = useRouter();
  const composite = useCompositeAction<typeof handlers>(settingsAction, {
    onSettled: () => router.invalidate(),
  });

  const [profileForm, profileFields] = useForm({
    id: "profile-form",
    lastResult:
      composite.data?.intent === "updateProfile" ? composite.data : undefined,
    constraint: getZodConstraint(handlers.updateProfile.schema),
    shouldValidate: "onSubmit",
    shouldRevalidate: "onBlur",
    onValidate: ({ formData }) =>
      parseWithZod(formData, { schema: handlers.updateProfile.schema }),
  });

  const [passwordForm, passwordFields] = useForm({
    id: "password-form",
    lastResult:
      composite.data?.intent === "changePassword" ? composite.data : undefined,
    constraint: getZodConstraint(handlers.changePassword.schema),
    shouldValidate: "onSubmit",
    shouldRevalidate: "onBlur",
    onValidate: ({ formData }) =>
      parseWithZod(formData, { schema: handlers.changePassword.schema }),
  });

  composite.register("updateProfile", {
    onSuccess: ({ data }) => toast.success(`${data.user.name} を更新しました`),
    onHandlerError: ({ error }) =>
      toast.error(error?.[""]?.[0] ?? "更新に失敗しました"),
  });

  composite.register("changePassword", {
    onSuccess: () => {
      toast.success("パスワードを変更しました");
      passwordForm.reset();
    },
    onHandlerError: ({ error }) =>
      toast.error(error?.currentPassword?.[0] ?? "変更に失敗しました"),
  });

  return (
    <div>
      <h2>プロフィール設定</h2>
      <composite.Form {...getFormProps(profileForm)}>
        <input type="hidden" name="intent" value="updateProfile" />

        <div>
          <label htmlFor={profileFields.name.id}>名前</label>
          <input {...getInputProps(profileFields.name, { type: "text" })} />
          <div className="text-destructive">{profileFields.name.errors}</div>
        </div>

        <div>
          <label htmlFor={profileFields.email.id}>メールアドレス</label>
          <input {...getInputProps(profileFields.email, { type: "email" })} />
          <div className="text-destructive">{profileFields.email.errors}</div>
        </div>

        <button type="submit" disabled={composite.isPending("updateProfile")}>
          {composite.isPending("updateProfile") ? "更新中..." : "更新"}
        </button>
      </composite.Form>

      <h2>パスワード変更</h2>
      <composite.Form {...getFormProps(passwordForm)}>
        <input type="hidden" name="intent" value="changePassword" />

        <div>
          <label htmlFor={passwordFields.currentPassword.id}>現在のパスワード</label>
          <input
            {...getInputProps(passwordFields.currentPassword, { type: "password" })}
          />
          <div className="text-destructive">
            {passwordFields.currentPassword.errors}
          </div>
        </div>

        <div>
          <label htmlFor={passwordFields.newPassword.id}>新しいパスワード</label>
          <input
            {...getInputProps(passwordFields.newPassword, { type: "password" })}
          />
          <div className="text-destructive">
            {passwordFields.newPassword.errors}
          </div>
        </div>

        <button type="submit" disabled={composite.isPending("changePassword")}>
          {composite.isPending("changePassword") ? "変更中..." : "変更"}
        </button>
      </composite.Form>
    </div>
  );
}
```

### ポイント

- intent ごとのバリデーション + ハンドラを `handlers` オブジェクトに集約。
  `useCompositeAction` のジェネリクス引数で型推論が効く。
- フィールドに紐付けたいエラーだけを `error({ field: [msg] })` で返し、それ以外の
  例外は `throw` してルートの `errorComponent` 側に任せる。
- `router.invalidate()` を `onSettled` で呼んで loader データを再取得する。

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
