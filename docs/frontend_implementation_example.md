# Frontend Implementation Example

## Handle function

```typescript
// app/presenters/handleUseCase.ts

import { ResultAsync } from "neverthrow";
import { formatError, getErrorStatusCode } from "@/presenters/error";

export type HandleError = {
  message: string;
  status: number;
};

/**
 * アプリケーションサービス（ユースケース）を実行し、ResultAsyncで返す
 */
export function handleUseCase<T>(fn: () => Promise<T>): ResultAsync<T, HandleError> {
  return ResultAsync.fromPromise(fn(), (error) => ({
    message: formatError(error),
    status: getErrorStatusCode(error),
  }));
}
```

## Loader

```typescript
// app/routes/posts/$postId/loader.ts

import { data, redirect } from "react-router";
import { getPost, listRelatedPosts } from "@/core/application/post";
import type { PostSummary } from "@/core/application/post/dto";
import { container } from "@/di/server";
import { handleUseCase } from "@/presenters/handleUseCase";
import type { Route } from "./+types/index";

export async function loader({ params, request }: Route.LoaderArgs) {
  const currentUser = await container.authProvider.getCurrentUser(
    request.headers,
  );
  if (!currentUser) {
    throw redirect("/login");
  }

  const postId = params.postId;

  // 必須データは await して返す
  const postResult = await handleUseCase(() =>
    getPost({
      container,
      headers: request.headers,
      input: { postId },
    }),
  ).match(
    (result) => result,
    (e) => {
      throw data({ message: e.message }, { status: e.status });
    },
  );

  // 遅延読み込みしたいデータは Promise のまま返す
  const relatedPostsPromise = handleUseCase(() =>
    listRelatedPosts({
      container,
      headers: request.headers,
      input: { postId, limit: 5 },
    }),
  ).match(
    (result) => result.posts,
    () => [] as PostSummary[],
  );

  return {
    post: postResult.post,
    relatedPostsPromise,
  };
}
```

```typescript
// app/routes/posts/$postId/index.tsx

import { Suspense, use } from "react";
import type { PostSummary } from "@/core/application/post/dto";
import type { Route } from "./+types/index";

export { loader } from "./loader";

export default function PostDetailPage({
  loaderData,
}: Route.ComponentProps) {
  const { post, relatedPostsPromise } = loaderData;

  return (
    <div>
      <h1>{post.title}</h1>
      <p>{post.content}</p>

      <Suspense fallback={<p>関連記事を読み込み中...</p>}>
        <RelatedPosts promise={relatedPostsPromise} />
      </Suspense>
    </div>
  );
}

// use フックを使うコンポーネント
function RelatedPosts({ promise }: { promise: Promise<PostSummary[]> }) {
  const relatedPosts = use(promise);

  return (
    <ul>
      {relatedPosts.map((post) => (
        <li key={post.id}>{post.title}</li>
      ))}
    </ul>
  );
}
```

## Action (multiple intents)

```typescript
// app/routes/settings/action.ts

import { z } from "zod";
import { updateProfile, changePassword } from "@/core/application/user";
import { container } from "@/di/server";
import { handleUseCase } from "@/lib/handleUseCase";
import {
  createCompositeAction,
  defineHandler,
  success,
  error,
} from "@/lib/compositeAction";
import type { Route } from "./+types/index";

const updateProfileSchema = z.object({
  name: z.string().min(1, "名前を入力してください"),
  email: z.string().email("有効なメールアドレスを入力してください"),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "現在のパスワードを入力してください"),
  newPassword: z.string().min(8, "パスワードは8文字以上で入力してください"),
});

export const handlers = {
  updateProfile: defineHandler({
    schema: updateProfileSchema,
    handler: async (value, args) => {
      return handleUseCase(() =>
        updateProfile({
          container,
          headers: args.request.headers,
          input: value,
        }),
      ).match(
        (result) => success({ user: result.user }),
        (e) => error({ "": [e.message] }),
      );
    },
  }),
  changePassword: defineHandler({
    schema: changePasswordSchema,
    handler: async (value, args) => {
      return handleUseCase(() =>
        changePassword({
          container,
          headers: args.request.headers,
          input: value,
        }),
      ).match(
        () => success(),
        (e) => error({ currentPassword: [e.message] }),
      );
    },
  }),
};

export async function action(args: Route.ActionArgs) {
  return createCompositeAction(args, handlers);
}
```

```typescript
// app/routes/settings/index.tsx

import {
  getFormProps,
  getInputProps,
  useForm,
} from "@conform-to/react";
import { getZodConstraint, parseWithZod } from "@conform-to/zod/v4";
import { useCompositeAction } from "@/lib/compositeAction";
import { toast } from "sonner";
import { handlers } from "./action";
import type { Route } from "./+types/index";

export { action } from "./action";

export default function SettingsPage(_props: Route.ComponentProps) {
  const fetcher = useCompositeAction<typeof handlers>();

  // プロフィール更新フォーム
  const [profileForm, profileFields] = useForm({
    id: "profile-form",
    lastResult: fetcher.data?.intent === "updateProfile" ? fetcher.data : undefined,
    constraint: getZodConstraint(handlers.updateProfile.schema),
    shouldValidate: "onSubmit",
    shouldRevalidate: "onBlur",
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: handlers.updateProfile.schema });
    },
  });

  // パスワード変更フォーム
  const [passwordForm, passwordFields] = useForm({
    id: "password-form",
    lastResult: fetcher.data?.intent === "changePassword" ? fetcher.data : undefined,
    constraint: getZodConstraint(handlers.changePassword.schema),
    shouldValidate: "onSubmit",
    shouldRevalidate: "onBlur",
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: handlers.changePassword.schema });
    },
  });

  fetcher.register("updateProfile", {
    onSuccess: ({ data }) => {
      toast.success(`${data.user.name} を更新しました`);
    },
    onHandlerError: ({ error }) => toast.error(error?.[""]?.[0] ?? "更新に失敗しました"),
  });

  fetcher.register("changePassword", {
    onSuccess: () => {
      toast.success("パスワードを変更しました");
      passwordForm.reset();
    },
    onHandlerError: ({ error }) => toast.error(error?.currentPassword?.[0] ?? "変更に失敗しました"),
  });

  const isPendingProfileForm = fetcher.isPending("updateProfile");
  const isPendingPasswordForm = fetcher.isPending("changePassword");

  return (
    <div>
      <h2>プロフィール設定</h2>
      <fetcher.Form method="post" {...getFormProps(profileForm)}>
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

        <button type="submit">{isPendingProfileForm ? "更新中..." : "更新"}</button>
      </fetcher.Form>

      <h2>パスワード変更</h2>
      <fetcher.Form method="post" {...getFormProps(passwordForm)}>
        <input type="hidden" name="intent" value="changePassword" />

        <div>
          <label htmlFor={passwordFields.currentPassword.id}>現在のパスワード</label>
          <input {...getInputProps(passwordFields.currentPassword, { type: "password" })} />
          <div className="text-destructive">{passwordFields.currentPassword.errors}</div>
        </div>

        <div>
          <label htmlFor={passwordFields.newPassword.id}>新しいパスワード</label>
          <input {...getInputProps(passwordFields.newPassword, { type: "password" })} />
          <div className="text-destructive">{passwordFields.newPassword.errors}</div>
        </div>

        <button type="submit">{isPendingPasswordForm ? "変更中..." : "変更"}</button>
      </fetcher.Form>
    </div>
  );
}
```
