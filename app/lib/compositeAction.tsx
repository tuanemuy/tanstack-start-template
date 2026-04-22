import type { SubmissionResult } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import {
  type FormHTMLAttributes,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import type { z } from "zod";

// ============================================================
// Result helpers
// ============================================================

/**
 * SubmissionResult に成功データを付与できる拡張型。
 *
 * - `success()` → `ActionResult<undefined>`
 * - `success({ user })` → `ActionResult<{ user: User }>`
 * - `error(...)` → `ActionResult<never>`（TData 推論を汚染しない）
 */
export type ActionResult<TData = undefined> = SubmissionResult & {
  data?: TData;
};

/** 成功レスポンスを返す（データなし） */
export function success(): ActionResult;
/** 成功レスポンスを返す（データ付き） */
export function success<TData>(data: TData): ActionResult<TData>;
export function success(data?: unknown): ActionResult<unknown> {
  return { status: "success", data };
}

/**
 * フィールドエラーを返す。
 *
 * 戻り値の型が `ActionResult<never>` なので、
 * `success()` と同じハンドラー内で返しても `TData` の推論に影響しない。
 */
export function error(errors: Record<string, string[]>): ActionResult<never> {
  return { status: "error", error: errors } as ActionResult<never>;
}

// ============================================================
// Handler types
// ============================================================

/**
 * スキーマ付きハンドラー定義。
 * バリデーションは dispatcher が自動で行うため、
 * handler には成功時の値だけが渡される。
 *
 * リクエストヘッダー・認証ユーザーが必要な場合は、
 * handler 内で `getRequestHeaders()` や `requireCurrentUser()` を直接呼ぶ。
 */
export type ValidatedActionHandler<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TData = undefined,
> = {
  schema: TSchema;
  handler: (
    value: z.output<TSchema>,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
};

/**
 * スキーマなしハンドラー定義（エスケープハッチ）。
 * ファイルアップロードなど Zod で扱いにくいケース用。
 */
export type RawActionHandler<TData = undefined> = {
  schema?: undefined;
  handler: (
    formData: FormData,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
};

/**
 * すべてのハンドラーを受け入れるためのワイドな型。
 *
 * `TData` に `any` を使っているのは existential type の代用。
 * TypeScript では「TData が何であれ受け入れる」ことを表現できないため、
 * `any` で共変・反変の制約を回避している。
 *
 * `TData` の型安全性は `defineHandler` の戻り値型と
 * `InferHandlerData` による抽出で担保されるため、
 * ここでの `any` が利用側に漏洩することはない。
 */
export type ActionHandler =
  | ValidatedActionHandler<z.ZodTypeAny, any>
  | RawActionHandler<any>;

// ============================================================
// defineHandler — 型推論のためのヘルパー
// ============================================================

/**
 * ハンドラーを定義する。
 *
 * 関数引数推論により `TSchema` と `TData` が自動で推論されるため、
 * `satisfies` や手動の型引数指定が不要になる。
 *
 * @example
 * ```ts
 * defineHandler({
 *   schema: z.object({ name: z.string() }),
 *   handler: async (value) => {
 *     const user = await updateUser(value);
 *     return success({ user });
 *   },
 * });
 * ```
 */
export function defineHandler<
  TSchema extends z.ZodTypeAny,
  TData = undefined,
>(def: {
  schema: TSchema;
  handler: (
    value: z.output<TSchema>,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
}): ValidatedActionHandler<TSchema, TData>;

export function defineHandler<TData = undefined>(def: {
  handler: (
    formData: FormData,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
}): RawActionHandler<TData>;

export function defineHandler(def: ActionHandler): ActionHandler {
  return def;
}

// ============================================================
// Result types — エラーの出処を型レベルで判別可能にする
// ============================================================

export type ErrorSource = "validation" | "handler";

export type CompositeResult<
  TIntent extends string = string,
  TData = unknown,
> = ActionResult<TData> & {
  intent: TIntent;
  source: ErrorSource | "handler";
};

export type CompositeSuccess<
  TIntent extends string = string,
  TData = undefined,
> = CompositeResult<TIntent, TData> & {
  status: "success";
  source: "handler";
  data: TData;
};

export type CompositeValidationError<TIntent extends string = string> =
  CompositeResult<TIntent, never> & {
    status: "error";
    source: "validation";
  };

export type CompositeHandlerError<TIntent extends string = string> =
  CompositeResult<TIntent, never> & {
    status: "error";
    source: "handler";
  };

export type CompositeError<TIntent extends string = string> =
  | CompositeValidationError<TIntent>
  | CompositeHandlerError<TIntent>;

type InferHandlerData<T extends ActionHandler> =
  T extends ValidatedActionHandler<any, infer D>
    ? D
    : T extends RawActionHandler<infer D>
      ? D
      : undefined;

/**
 * ハンドラー群から ActionData のユニオン型を導出。
 *
 * 各 intent ごとに成功型（data 付き）と 2 種類のエラー型のユニオンになる。
 */
export type InferActionData<T extends Record<string, ActionHandler>> = {
  [K in keyof T & string]:
    | CompositeSuccess<K, InferHandlerData<T[K]>>
    | CompositeValidationError<K>
    | CompositeHandlerError<K>;
}[keyof T & string];

// ============================================================
// Server dispatcher
// ============================================================

/**
 * フォームの hidden field `intent` を読み取り、
 * スキーマでバリデーション → 対応するハンドラーに振り分ける。
 *
 * `createServerFn` の `handler` から呼ぶことを想定している。
 *
 * @example
 * ```ts
 * import { createServerFn } from "@tanstack/react-start";
 *
 * export const handlers = {
 *   updateProfile: defineHandler({
 *     schema: z.object({ name: z.string() }),
 *     handler: async (value) => {
 *       await requireCurrentUser();
 *       const { user } = await updateProfileUseCase({
 *         container, headers: getRequestHeaders(), input: value,
 *       });
 *       return success({ user });
 *     },
 *   }),
 *   changePassword: defineHandler({ ... }),
 * };
 *
 * export const settingsAction = createServerFn({ method: "POST" })
 *   .inputValidator((formData: FormData) => formData)
 *   .handler(({ data }) => createCompositeAction(data, handlers));
 * ```
 */
export async function createCompositeAction<
  T extends Record<string, ActionHandler>,
>(formData: FormData, handlers: T): Promise<InferActionData<T>> {
  const intent = formData.get("intent");

  if (typeof intent !== "string" || intent === "") {
    throw new Response('Missing "intent" field in form data', { status: 400 });
  }

  if (!(intent in handlers)) {
    throw new Response(`Unknown intent: "${intent}"`, { status: 400 });
  }

  const def = handlers[intent]!;
  let result: ActionResult<unknown>;
  let source: ErrorSource | "handler";

  if (def.schema) {
    const submission = parseWithZod(formData, { schema: def.schema });

    if (submission.status !== "success") {
      result = submission.reply();
      source = "validation";
    } else {
      result = await def.handler(submission.value);
      source = "handler";
    }
  } else {
    result = await (def as RawActionHandler<unknown>).handler(formData);
    source = "handler";
  }

  return { ...result, intent, source } as InferActionData<T>;
}

// ============================================================
// Client hook
// ============================================================

type CompositeServerFn<T extends Record<string, ActionHandler>> = (params: {
  data: FormData;
}) => Promise<InferActionData<T>>;

/**
 * 複数 intent を持つ composite action 用のクライアントフック。
 *
 * - `Form` コンポーネントを返し、サブミット時に内部で `createServerFn` を呼ぶ
 * - `register(intent, callbacks)` で intent ごとの完了コールバックを登録
 * - コールバックはエラーの種類ごとに分けて登録できる
 *
 * @example
 * ```tsx
 * const composite = useCompositeAction<typeof handlers>(settingsAction, {
 *   onSettled: () => router.invalidate(),
 * });
 *
 * composite.register("updateProfile", {
 *   onSuccess: ({ data }) => toast.success(`${data.user.name} を更新しました`),
 *   onHandlerError: ({ error }) => toast.error(error?.[""]?.[0] ?? "失敗"),
 * });
 *
 * <composite.Form>
 *   <input type="hidden" name="intent" value="updateProfile" />
 *   ...
 * </composite.Form>
 * ```
 */
export function useCompositeAction<
  THandlers extends Record<string, ActionHandler>,
>(
  serverFn: CompositeServerFn<THandlers>,
  options?: {
    onSettled?: (data: InferActionData<THandlers>) => void | Promise<void>;
  },
) {
  type ActionData = InferActionData<THandlers>;
  type Intent = keyof THandlers & string;

  type SuccessOf<I extends Intent> = Extract<
    ActionData,
    { intent: I; status: "success" }
  >;
  type ValidationErrorOf<I extends Intent> = Extract<
    ActionData,
    { intent: I; status: "error"; source: "validation" }
  >;
  type HandlerErrorOf<I extends Intent> = Extract<
    ActionData,
    { intent: I; status: "error"; source: "handler" }
  >;
  type ErrorOf<I extends Intent> = ValidationErrorOf<I> | HandlerErrorOf<I>;

  interface Callbacks<I extends Intent> {
    onSuccess?: (data: SuccessOf<I>) => void;
    onValidationError?: (data: ValidationErrorOf<I>) => void;
    onHandlerError?: (data: HandlerErrorOf<I>) => void;
    onError?: (data: ErrorOf<I>) => void;
  }

  interface InternalCallbacks {
    onSuccess?: (data: any) => void;
    onValidationError?: (data: any) => void;
    onHandlerError?: (data: any) => void;
    onError?: (data: any) => void;
  }

  const callbacksRef = useRef(new Map<Intent, InternalCallbacks>());
  const [data, setData] = useState<ActionData | undefined>(undefined);
  const [submittingIntent, setSubmittingIntent] = useState<Intent | null>(null);
  const [isPending, startTransition] = useTransition();

  const dispatchCallbacks = useCallback((result: ActionData) => {
    const cbs = callbacksRef.current.get(result.intent as Intent);
    if (!cbs) return;

    if (result.status === "success") {
      cbs.onSuccess?.(result);
    } else if (result.source === "validation") {
      const handler = cbs.onValidationError ?? cbs.onError;
      handler?.(result);
    } else {
      const handler = cbs.onHandlerError ?? cbs.onError;
      handler?.(result);
    }
  }, []);

  const submit = useCallback(
    (formData: FormData) => {
      const intent = formData.get("intent");
      if (typeof intent !== "string" || intent === "") return;

      setSubmittingIntent(intent as Intent);
      startTransition(async () => {
        try {
          const result = await serverFn({ data: formData });
          setData(result);
          dispatchCallbacks(result);
          await options?.onSettled?.(result);
        } finally {
          setSubmittingIntent(null);
        }
      });
    },
    [serverFn, dispatchCallbacks, options],
  );

  const Form = useMemo(
    () =>
      function CompositeForm({
        children,
        onSubmit,
        ...props
      }: FormHTMLAttributes<HTMLFormElement> & { children?: ReactNode }) {
        return (
          <form
            method="post"
            {...props}
            onSubmit={(event) => {
              onSubmit?.(event);
              if (event.defaultPrevented) return;
              event.preventDefault();
              submit(new FormData(event.currentTarget));
            }}
          >
            {children}
          </form>
        );
      },
    [submit],
  );

  const register = useCallback(
    <I extends Intent>(intent: I, callbacks: Callbacks<I>) => {
      callbacksRef.current.set(intent, callbacks);
    },
    [],
  );

  const isSubmitting = useCallback(
    (intent: Intent) => isPending && submittingIntent === intent,
    [isPending, submittingIntent],
  );

  return {
    Form,
    submit,
    register,
    data,
    isPending: isSubmitting,
    isSubmitting,
    submittingIntent,
  };
}
