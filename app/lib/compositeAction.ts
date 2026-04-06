import type { SubmissionResult } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { useCallback, useEffect, useRef } from "react";
import { type ActionFunctionArgs, useFetcher } from "react-router";
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
 */
export type ValidatedActionHandler<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TData = undefined,
> = {
  schema: TSchema;
  handler: (
    value: z.output<TSchema>,
    args: ActionFunctionArgs,
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
    args: ActionFunctionArgs,
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
 * // スキーマ付き — value, TData ともに推論される
 * defineHandler({
 *   schema: z.object({ name: z.string() }),
 *   handler: async (value, args) => {
 *     const user = await db.user.update({ data: value });
 *     return success({ user }); // TData = { user: User }
 *   },
 * });
 *
 * // スキーマなし — formData が渡される
 * defineHandler({
 *   handler: async (formData, args) => {
 *     const file = formData.get("avatar") as File;
 *     const url = await uploadFile(file);
 *     return success({ url }); // TData = { url: string }
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
    args: ActionFunctionArgs,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
}): ValidatedActionHandler<TSchema, TData>;

export function defineHandler<TData = undefined>(def: {
  handler: (
    formData: FormData,
    args: ActionFunctionArgs,
  ) => Promise<ActionResult<TData>> | ActionResult<TData>;
}): RawActionHandler<TData>;

export function defineHandler(def: ActionHandler): ActionHandler {
  return def;
}

// ============================================================
// Result types — エラーの出処を型レベルで判別可能にする
// ============================================================

/**
 * エラーの発生源を示す discriminant。
 *
 * - `"validation"` — Zod スキーマによるバリデーション失敗。
 *   フィールドごとのエラーメッセージが `error` に含まれる。
 * - `"handler"` — ハンドラー内のビジネスロジックエラー。
 *   DB 制約違反、権限エラーなど。
 */
export type ErrorSource = "validation" | "handler";

/** intent + source を付与した共通の結果型 */
export type CompositeResult<
  TIntent extends string = string,
  TData = unknown,
> = ActionResult<TData> & {
  intent: TIntent;
  source: ErrorSource | "handler";
};

/** 成功 */
export type CompositeSuccess<
  TIntent extends string = string,
  TData = undefined,
> = CompositeResult<TIntent, TData> & {
  status: "success";
  source: "handler";
  data: TData;
};

/** バリデーションエラー（Zod / Conform 由来） */
export type CompositeValidationError<TIntent extends string = string> =
  CompositeResult<TIntent, never> & {
    status: "error";
    source: "validation";
  };

/** ハンドラーエラー（ビジネスロジック由来） */
export type CompositeHandlerError<TIntent extends string = string> =
  CompositeResult<TIntent, never> & {
    status: "error";
    source: "handler";
  };

/** すべてのエラー型のユニオン */
export type CompositeError<TIntent extends string = string> =
  | CompositeValidationError<TIntent>
  | CompositeHandlerError<TIntent>;

/** ハンドラーから TData を抽出する */
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
 * - バリデーション失敗時は handler を呼ばず `submission.reply()` を返す
 * - 返却値には `intent` と `source` フィールドが付与される
 *
 * @example
 * ```ts
 * import { z } from "zod";
 *
 * const handlers = {
 *   updateProfile: defineHandler({
 *     schema: z.object({ name: z.string(), email: z.string().email() }),
 *     handler: async (value, args) => {
 *       const user = await db.user.update({
 *         where: { id: args.params.id },
 *         data: value,
 *       });
 *       return success({ user });
 *     },
 *   }),
 *   changePassword: defineHandler({
 *     schema: z.object({
 *       current: z.string(),
 *       next: z.string().min(8),
 *     }),
 *     handler: async (value, args) => {
 *       const ok = await changePassword(args.params.id!, value.current, value.next);
 *       if (!ok) {
 *         return error({ current: ["現在のパスワードが正しくありません"] });
 *       }
 *       return success();
 *     },
 *   }),
 *   uploadAvatar: defineHandler({
 *     handler: async (formData, args) => {
 *       const file = formData.get("avatar") as File;
 *       const url = await uploadFile(file);
 *       return success({ url });
 *     },
 *   }),
 * };
 *
 * export type ActionData = InferActionData<typeof handlers>;
 *
 * export async function action(args: ActionFunctionArgs) {
 *   return createCompositeAction(args, handlers);
 * }
 * ```
 */
export async function createCompositeAction<
  T extends Record<string, ActionHandler>,
>(args: ActionFunctionArgs, handlers: T): Promise<InferActionData<T>> {
  const formData = await args.request.formData();
  const intent = formData.get("intent");

  // ── intent のバリデーション ──
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
    // ── スキーマ付き: 自動バリデーション ──
    const submission = parseWithZod(formData, { schema: def.schema });

    if (submission.status !== "success") {
      result = submission.reply();
      source = "validation";
    } else {
      result = await def.handler(submission.value, args);
      source = "handler";
    }
  } else {
    // ── スキーマなし: formData をそのまま渡す ──
    result = await (def as RawActionHandler<unknown>).handler(formData, args);
    source = "handler";
  }

  return { ...result, intent, source } as InferActionData<T>;
}

// ============================================================
// Hook
// ============================================================

/**
 * 複数の intent を持つ composite action 用の fetcher フック。
 *
 * - `useFetcher` のすべてのプロパティをそのまま使える
 * - `register(intent, callbacks)` で intent ごとの完了コールバックを登録
 * - コールバックはエラーの種類ごとに分けて登録できる:
 *   - `onSuccess` — 成功時（data は intent ごとの型が推論される）
 *   - `onValidationError` — Zod バリデーション失敗時
 *   - `onHandlerError` — ハンドラー内のビジネスロジックエラー時
 *   - `onError` — 上記 2 つの catch-all
 *
 * @example
 * ```tsx
 * function SettingsPage() {
 *   const fetcher = useCompositeAction<typeof handlers>();
 *
 *   fetcher.register("updateProfile", {
 *     onSuccess: (data) => {
 *       // data.data.user — User 型で型安全にアクセスできる
 *       toast.success(`${data.data.user.name} を更新しました`);
 *     },
 *     onValidationError: () => {
 *       // フィールドエラーは Conform が自動表示するため何もしなくてもOK
 *     },
 *     onHandlerError: () => toast.error("更新に失敗しました"),
 *   });
 *
 *   fetcher.register("changePassword", {
 *     onSuccess: () => {
 *       toast.success("パスワードを変更しました");
 *       passwordForm.reset();
 *     },
 *     // onError で validation / handler 両方をまとめてハンドル
 *     onError: () => toast.error("パスワード変更に失敗しました"),
 *   });
 *
 *   fetcher.register("uploadAvatar", {
 *     onSuccess: (data) => {
 *       // data.data.url — string と推論される
 *       setAvatarUrl(data.data.url);
 *     },
 *   });
 *
 *   return (
 *     <fetcher.Form method="post">
 *       <input type="hidden" name="intent" value="updateProfile" />
 *       ...
 *     </fetcher.Form>
 *   );
 * }
 * ```
 */
export function useCompositeAction<
  THandlers extends Record<string, ActionHandler>,
>() {
  type ActionData = InferActionData<THandlers>;
  type Intent = keyof THandlers & string;

  // intent ごとの成功型を抽出（data の型が intent ごとに異なる）
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
    /** 成功時（data は intent ごとの型が推論される） */
    onSuccess?: (data: SuccessOf<I>) => void;
    /** Zod バリデーション失敗時。指定がなければ onError にフォールバック */
    onValidationError?: (data: ValidationErrorOf<I>) => void;
    /** ハンドラー内ビジネスロジックエラー時。指定がなければ onError にフォールバック */
    onHandlerError?: (data: HandlerErrorOf<I>) => void;
    /** バリデーション・ハンドラーエラー両方の catch-all */
    onError?: (data: ErrorOf<I>) => void;
  }

  const fetcher = useFetcher<CompositeResult>();

  //
  // ── 内部ストレージ用の緩い型 ──
  // 型安全性は onDone のシグネチャ（Callbacks<I>）で担保する。
  // Map 内部では any で保持し、dispatch 時にキャストする。
  interface InternalCallbacks {
    onSuccess?: (data: any) => void;
    onValidationError?: (data: any) => void;
    onHandlerError?: (data: any) => void;
    onError?: (data: any) => void;
  }

  // ── コールバック管理 ──
  // Map に intent → 最新コールバックを保持。
  // register() はレンダーごとに呼ばれる想定なので、常に最新値に上書きされる。
  const callbacksRef = useRef(new Map<Intent, InternalCallbacks>());

  // ── 状態遷移の検出 ──
  // 「submitting/loading → idle」の遷移を正確に検出する。
  const prevStateRef = useRef(fetcher.state);

  useEffect(() => {
    const wasActive = prevStateRef.current !== "idle";
    prevStateRef.current = fetcher.state;

    // idle に戻った瞬間 かつ 直前にアクティブだった場合のみ発火
    if (fetcher.state !== "idle" || !wasActive || !fetcher.data) {
      return;
    }

    const intent = fetcher.data.intent as Intent;
    const cbs = callbacksRef.current.get(intent);
    if (!cbs) return;

    if (fetcher.data.status === "success") {
      cbs.onSuccess?.(fetcher.data as SuccessOf<typeof intent>);
    } else if (fetcher.data.source === "validation") {
      // バリデーションエラー: 専用コールバック → catch-all の順で探す
      const handler = cbs.onValidationError ?? cbs.onError;
      handler?.(fetcher.data as ValidationErrorOf<typeof intent>);
    } else {
      // ハンドラーエラー: 専用コールバック → catch-all の順で探す
      const handler = cbs.onHandlerError ?? cbs.onError;
      handler?.(fetcher.data as HandlerErrorOf<typeof intent>);
    }
  }, [fetcher.state, fetcher.data]);

  // ── register ──
  // ジェネリックパラメータ I で intent を絞り、
  // コールバック引数の data 型が intent ごとに推論される。
  const register = useCallback(
    <I extends Intent>(intent: I, callbacks: Callbacks<I>) => {
      callbacksRef.current.set(intent, callbacks);
    },
    [],
  );

  const isSubmitting = (intent: Intent) => {
    return (
      fetcher.state === "submitting" &&
      fetcher.formData?.get("intent") === intent
    );
  };

  const isPending = (intent: Intent) => {
    return (
      fetcher.state !== "idle" && fetcher.formData?.get("intent") === intent
    );
  };

  return { ...fetcher, register, isSubmitting, isPending };
}
