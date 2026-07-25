# Frontend Implementation Example

Implementation example assuming TanStack Start (with React Server Components enabled).

Basic design principles:

- **Choose RSC with an awareness of its "owner".** An RSC is nothing more than a React Flight payload returned from `createServerFn`. Decide first where you call it from = who holds that payload.
- **Keep data fetching, authorization, and usecase invocation entirely inside server components.** Treat the loader as "a thin proxy for pulling a server component in as an RSC payload".
- **`throw` errors.** There is no need to convert them to status codes and return them via `data()`. Throwing `redirect({ to })` / `notFound()` lets the router pick them up, and any other exception falls back to the route's `errorComponent`.
- **Carve out only the parts that need client state with `"use client"`.** Make only the parts that hold forms or interactions into client components.
- **When calling a server function from the client, wrap it with `useServerFn(fn)`.** This way, even when the usecase does `throw redirect({ to })`, the router navigates automatically.

## RSC owner patterns

There are 4 ways to handle an RSC, distinguished by **who holds and invalidates the Flight payload**. The route loader is not the only correct answer.

### 1. Held by the route loader (the default in this template)

A fragment tied 1:1 to the URL. The router cache owns it and refetches it via `router.invalidate()`.

```tsx
// apps/web/app/routes/index.tsx
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { sanitizeRouteError } from "@/presentation/errorDisplay";

const loadTodoListRouteData = createServerFn({ method: "GET" }).handler(
  async () => {
    const { TodoList } = await import("@/components/todo/TodoList");
    const Rendered = await renderServerComponent(<TodoList />);
    return { TodoList: Rendered };
  },
);

export const Route = createFileRoute("/")({
  // Cache the resolved RSC in prod so a revisit reuses it; keep `0` in DEV for HMR.
  // Freshness after a mutation is driven by an explicit `useRouter().invalidate()`,
  // not by re-running the loader on every navigation. (See the streaming variant
  // below for why `staleTime: 0` is actively harmful once the payload is deferred.)
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  loader: () => loadTodoListRouteData(),
  component: HomePage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>An error occurred</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});

function HomePage() {
  const { TodoList } = Route.useLoaderData();
  return <>{TodoList}</>;
}
```

Since the route file also enters the client graph, do not statically import server-only DI or server components. Confine them to the `createServerFn` / `.server.ts` side, and have the loader merely call that bridge.

**When to choose**: fragments uniquely determined by URL parameters, such as list and detail pages.

#### Streaming variant: defer the payload and show a skeleton

The example above `await`s the RSC payload in the loader, so navigation blocks until the data is fully resolved (no fallback is ever shown). To make the shell appear instantly and stream the fragment in, have the bridge **return the unresolved promise** and let a client-side `<Suspense>` boundary render a skeleton until the React Flight payload arrives. This is the recommended default for list/detail fragments.

```tsx
// bridge — return the UNRESOLVED promise (do not await renderServerComponent)
export const renderTodoList = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paginationSchema))
  .handler(async ({ data }) => {
    const { TodoList } = await import("@/components/todo/TodoList");
    return { TodoList: renderServerComponent(<TodoList pagination={data} />) };
  });

// route — forward the inner promise, resolve it under <Suspense>
export const Route = createFileRoute("/todo/")({
  // MANDATORY for the streaming variant. The loaderData holds an unresolved
  // promise; under `staleTime: 0` a revisit re-runs the loader, produces a fresh
  // promise, and the Suspense boundary re-suspends — so the cached list flashes
  // back to the skeleton on every back-navigation / in-app link. Caching the
  // settled promise (Infinity in prod) keeps the resolved list on screen; mutation
  // freshness comes from the explicit `router.invalidate()`, not from re-fetching.
  staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY,
  loader: async ({ deps }) => {
    const { TodoList } = await renderTodoList({ data: deps });
    return { TodoList }; // TodoList is still a Promise<ReactNode>
  },
  component: TodoPage,
});

function TodoPage() {
  const { TodoList } = Route.useLoaderData();
  return (
    <Suspense fallback={<TodoListSkeleton />}>
      <Deferred promise={TodoList} />
    </Suspense>
  );
}

// apps/web/app/components/ui/Deferred — generic, reusable client resolver
("use client");
export function Deferred<T extends ReactNode>({ promise }: { promise: Usable<T> }) {
  return use(promise);
}
```

The skeleton (`apps/web/app/components/ui/Skeleton` for the generic block, `apps/web/app/components/todo/TodoListSkeleton` shaped to `TodoBoard`'s DOM) carries one `role="status"` announcement; the individual bars are `aria-hidden` and respect `prefers-reduced-motion` via `motion-reduce:animate-none`.

This is the **per-fragment** loading mechanism. For navigation pending UI on routes whose loader genuinely *blocks*, use the router's `defaultPendingComponent` (+ `defaultPendingMs` / `defaultPendingMinMs`) in `apps/web/app/router.tsx` instead — a streaming route like `/todo` settles its loader immediately and never triggers it.

### 2. Held by TanStack Query

For widgets that are not route-shaped, or when you want to invalidate independently. `structuralSharing: false` is mandatory when putting RSC values into Query.

```tsx
// apps/web/app/routes/posts/$postId.tsx
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
  structuralSharing: false, // mandatory when putting RSC values into Query
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

**When to choose**: widgets you want to reuse across multiple routes, refetch in the background, or keep alive across routes.

### 3. Call directly from an event handler

Load an RSC triggered by a user action and push it into state.

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
        Load more
      </button>
      {fragment}
    </>
  );
}
```

**When to choose**: when you don't want it included in the initial load and want to fetch it incrementally on user action.

### 4. Composite Component (embedding client slots)

> **Current status**: not adopted in this template. The Todo UI is complete with a loader + ordinary `"use client"` components, so it is unnecessary. It is kept as a reference pattern for when you eventually need to inject client interactivity into server-rendered markup.

Use this when you want to inject client interactivity into server-rendered markup. Three kinds of slots are available: `children`, a render prop, and a component prop.

```tsx
// server side
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
// client side
import { CompositeComponent } from "@tanstack/react-start/rsc";

<CompositeComponent
  src={src}
  renderActions={({ postId }) => <LikeButton postId={postId} />}
/>;
```

**When to choose**: when you want to inject a client UI such as a "like button" into server-rendered output. When you find yourself wanting to peek into a server slot with `Children.map` / `cloneElement`, convert it to a render prop.

### Selection flow

| Condition | What to choose |
|---|---|
| Tied 1:1 to the URL | **loader** |
| Used across routes / independent invalidate | **Query** |
| Don't want it in the initial load, triggered by user action | **Direct call from an event handler** |
| Want to mix a client UI into server markup | **Composite Component** |
| Want immediate add/remove of list elements | **Client-owned** (below) |

**Bad pattern**: "dual ownership" where the same RSC is fetched by both the loader and Query and only one is invalidated.

### Held by the client (optimistic list updates)

A loader-owned RSC list can reflect within-element state (checkboxes, etc.) immediately via `useOptimistic`, but **operations that change membership, such as add/remove, are changes to parent state**, so an item-local `useOptimistic` cannot reach them. Carve the list out into a `"use client"` island and own the entire list array with `useOptimistic(todos, reducer)`, seeded by the server value the loader returns.

**Who calls the server function is determined by "the kind of operation"**:

- In-item operations (toggle / inline rename) have the leaf call the server function itself. Since membership doesn't change and the leaf survives, the item-local `useOptimistic` and error display can also live in the leaf.
- Operations that change membership (add / remove) have the owner (the island) call the server function. In particular, **delete must be called by the owner**: with optimistic deletion the leaf unmounts before the request settles, so the error UI placed in the leaf would be discarded. Add is dispatched from the form's action (the form lives outside the list and survives the round trip).

Every operation calls `router.invalidate()` once it settles, and the optimistic list is re-based onto the refetched latest value (it reverts automatically on failure). Example: `apps/web/app/components/todo/TodoBoard`.

**When to choose**: when you want to reflect additions/removals to a list within the page immediately. Keeping it loader-owned forces add/remove to always wait on a server round trip, making it feel sluggish.

## Canonical form of the server-only entry point

The template standard is to access usecase invocation on the server **via the helpers in `apps/web/app/presentation/serverAction.ts`**. Calling `getContainer()` directly does technically work, but in this template we consolidate on the helpers.

### The 2 helpers provided

| helper | Purpose |
|---|---|
| `serverData(loadModule, run)` | **Reads** from server components / loaders |
| `loadServerDeps(loadModule)` | Loads the DI + usecase module in parallel inside a server function handler |

Both run `getContainer()` and the **dynamic import** of the usecase module (see the JSDoc in `serverAction.ts` for the reason) in parallel.

### Declare the server function itself **inline** at the call site

A server function (mutation / GET loader bridge) must **always have the chain from `createServerFn(...)` through `.handler(...)` written directly at the call site**. Pre-applying common middleware in a separate module and exporting it is **NG**.

```ts
// ✅ correct — complete the chain at the call site
export const createTodoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/todo/createTodo"),
    );
    return module.createTodo({ container, input: data });
  });

// ❌ NG — importing a pre-built builder from a separate module
// breaks the build because TanStack Start's RSC plugin can't trace the chain root.
import { defineServerFn } from "@/presentation/serverFn";
export const createTodoFn = defineServerFn
  .inputValidator(validateInput(createTodoSchema))
  .handler(/* ... */);
```

TanStack Start's RSC plugin separates the handler body into the RSC environment on the premise that **a literal `createServerFn(...)` call exists within the same module**. If you start the chain through a re-export, static analysis fails and the build falls over with `Errored while resolving ... Got Plugin driver is already dropped` (verified on real hardware). A bit of duplication (writing `.middleware([...])` with `errorResponseMiddleware` every time) is acceptable.

### Division of transport-validation responsibility (serverData vs serverAction)

The fact that `serverData` **does not take a schema** is a deliberate design choice: it declares in the type signature "the precondition that the caller has already passed the transport boundary". In other words, the following usage split is the convention in this template:

| Input source | Validation point | wrapper |
|---|---|---|
| URL search params | route's `validateSearch: schema.parse` | `serverData` (receives the value trusting the type) |
| Forwarding from a parent server fn | parent fn's `inputValidator(schema)` | `serverData` (receives the value trusting the type) |
| Direct POST from the client | `serverAction`'s `inputValidator(schema)` | `serverAction` |

> **Convention**: `serverData` is **for internal calls only**. Any place that handles external input (URL / form / fetch) must **always finish transport validation with either `validateSearch` or `serverAction` before** passing arguments to a loader via `serverData`. Do not run Zod again right before the usecase (the VO factory re-validates the same constraints, so it would be a duplicate and would diverge from CLAUDE.md's "validate at the boundaries").

Example: `apps/web/app/routes/todo/index.tsx` normalizes the URL into the Pagination type with `validateSearch: paginationSearchSchema.parse`, then `renderTodoList` (a server fn) re-validates the transport with `inputValidator(paginationSchema)` → passes a typed value to the server component `TodoList`, and `loadTodos(pagination)` (wrapped with `serverData`) **merely trusts** that type. Of the three stages, validation is confined to **the first two transport boundaries**, and the internal `serverData` is a noop.

### Exception where calling `getContainer()` directly is allowed

A helper function that **just hits a specific port in one line**, like `container.authProvider`, and needs no usecase module may call `getContainer()` directly without going through a wrapper (see `getCurrentUser` below). Always place `import "@tanstack/react-start/server-only";` at the top of the file.

## Server component (with data fetching)

The server component itself is an `async` function that calls a loader wrapped with `serverData`. React's `cache()` suppresses duplicate data fetching within the same request.

```tsx
// apps/web/app/components/post/PostDetail.tsx (server component)

import { cache } from "react";
import { notFound } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { isNotFoundError } from "@repo/core/application/errors";
import { serverData } from "@/presentation/serverAction";
import { RelatedPosts } from "./RelatedPosts";

const loadPost = cache(
  serverData(
    () => import("@repo/core/application/post/getPost"),
    async ({ container }, { getPost }, postId: string) => {
      try {
        return await getPost({
          container,
          headers: getRequestHeaders(),
          input: { postId },
        });
      } catch (e) {
        if (isNotFoundError(e)) throw notFound();
        throw e;
      }
    },
  ),
);

export async function PostDetail({ postId }: { postId: string }) {
  const { post } = await loadPost(postId);

  return (
    <article>
      <h1>{post.title}</h1>
      <p className="text-muted">by {post.authorName}</p>
      <div>{post.content}</div>

      <RelatedPosts postId={postId} />
    </article>
  );
}
```

### Points

- Because we `await` inside the server component, there is no need to assemble the data in the loader.
- For exception mapping after authentication/existence checks, `try/catch` + `throw redirect/notFound` is sufficient.
- **The dedupe scope of `cache()` is the same request + the same arguments**. Calling `loadPost(id)` multiple times within the same RSC tree executes only once, and a different `id` is evaluated independently with a separate cache. A loader that takes no arguments should be wrapped with `cache(serverData(...))` and called via **the same function reference** (e.g. `loadTodos` in `apps/web/app/components/todo/TodoList/action.ts`).
- Consolidate the DI / module loading for usecase invocation on the `serverData` wrapper. Calling `getContainer()` directly requires writing `import "@tanstack/react-start/server-only";` every time, and the moment someone adds a single static import line, the server graph risks leaking into the client; the wrapper's dynamic import structurally blocks this.

## Route definition (a thin proxy that pulls in an RSC)

The route's only responsibility is "pass URL parameters to the server component and send the rendered result to the client as an RSC payload".

```tsx
// apps/web/app/routes/posts/$postId.tsx

import { createFileRoute } from "@tanstack/react-router";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";

import { createServerFn } from "@tanstack/react-start";

import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";

const renderPostDetail = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
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
  errorComponent: ({ error }) => <div role="alert">Error: {error.message}</div>,
  notFoundComponent: () => <div>Post not found</div>,
});

function PostPage() {
  const { Detail } = Route.useLoaderData();
  return Detail;
}
```

### Points

- The loader merely calls the server function bridge. Confine `renderServerComponent(<RSC />)` and server-only imports to the bridge's handler side.
- **Place the shared shell (Header / Sidebar / Dialog mount, etc.) in the parent route's `component`. Do not include the shell in the arguments to the leaf's `renderServerComponent(...)`.** If you do, the shell gets swapped out along with the entire RSC tree and remounted on every transition, and client state such as sidebar open/close is lost and flickers. Pass only leaf-specific content into the RSC payload. Reference implementations: `apps/web/app/components/todo/TodoShell/` and `apps/web/app/routes/todo/{route,about,index}.tsx`.
- Since `staleTime` remains in effect even after navigation, the cache can be reused when you return to the same URL.
- When you want to force a refetch, use `useRouter().invalidate()` on the client.
- Input validation uses `.inputValidator(...)`. **Do not use the old API `.validator(...)`.**

## Shared server logic (authentication helper)

Authentication retrieval used by multiple server components / server functions is carved out as a function and memoized with `cache()`. Since it is a **one-line port access** with no usecase module, this falls under the escape-hatch pattern of calling `getContainer()` directly rather than `serverData`.

```typescript
// packages/core/src/lib/server/currentUser.ts

import "@tanstack/react-start/server-only";

import { cache } from "react";
import { redirect } from "@tanstack/react-router";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { getContainer } from "@repo/core/application/di/containerStore";
import type { User } from "@repo/core/domain/user/entity";

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

Just calling `await requireCurrentUser()` from a server component or server function completes the authentication check. Instead of using `createMiddleware`, aligning on a simple helper pairs better with RSC.

The `import "@tanstack/react-start/server-only";` at the top of the file is a mandatory guard when taking the escape hatch. Where usecase invocation enters, switch over to going through `serverData` / `serverAction` and graduate from this.

## Server Function (mutation)

Consolidate state-changing operations into `createServerFn({ method: "POST" })`. For reads, use `createServerFn({ method: "GET" })`, expressing whether there are side effects via the method. For both, always prepend `.middleware([errorResponseMiddleware])`, and have the same middleware catch throws from **both** `inputValidator` and the handler and convert them into the `AppServerError` envelope and an HTTP status. The client wraps it with `useServerFn(fn)` and then passes it directly to React 19's **`useActionState` / `useTransition` / `useOptimistic`**. A generic hook (a `useServerAction`-style wrapper) is intentionally not provided — abstract only when a second concrete pattern appears.

### Division of input-validation responsibility

Input validation happens in **only 2 places**. The usecase is not involved.

| Layer | Responsibility |
|---|---|
| Transport boundary (`inputValidator`) | shape / DoS check. Only whether the JSON matches the expected signature |
| Domain VO factory (`TodoTitle.create`, etc.) | The final gate for business invariants |

The usecase **trusts the static type of the input and focuses on applying domain logic**. When the VO factory throws a `BusinessRuleError`, it reaches the client as-is in the envelope (`{ kind: "business" }`).

Why not run Zod in the usecase:

- The VO factory re-validates the same constraints, so it would be a duplicate.
- Placing validation in the usecase mixes Zod / domain modules into the application layer, creating friction with CLAUDE.md's dependency direction (application → domain).
- Shape checking is the transport's responsibility. Once it arrives as a type, the usecase may trust it.

Because `createServerFn`'s `inputValidator` runs on both client and server, the schema statically imported from it **must not pull in `@repo/core/domain/*` or `@repo/core/application/*` at all**. Keep the schema presentation-independent in `apps/web/app/components/${domain}/schema.ts`.

```typescript
// apps/web/app/components/todo/schema.ts
import { z } from "zod";

export const TODO_TITLE_MAX_LENGTH = 140;

export const createTodoSchema = z.object({
  title: z.string().trim().min(1).max(TODO_TITLE_MAX_LENGTH),
});
```

```typescript
// apps/web/app/presentation/validator.ts
import { type z, type ZodType } from "zod";
import { CodedError, type FieldErrors } from "@repo/core/lib/error";
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
// apps/web/app/components/todo/CreateTodoForm/action.ts
import { createServerFn } from "@tanstack/react-start";

import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { createTodoSchema } from "../schema";

export const createTodoFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(createTodoSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/todo/createTodo"),
    );
    return module.createTodo({ container, input: data });
  });
```

### Form submission uses `useActionState`

`<form action={formAction}>` + `useActionState` is the canonical React 19 approach. Fold `SerializedError | null` into the state, and for a `validation` error, output `fieldErrors` as-is on a per-field basis.

```tsx
// apps/web/app/components/todo/CreateTodoForm/index.tsx
"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useActionState, useState } from "react";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { createTodoFn } from "./action";
import { TODO_TITLE_MAX_LENGTH } from "../schema";

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
        Title
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
        {isPending ? "Creating..." : "Add"}
      </button>
      {summary ? <p role="alert">{summary}</p> : null}
    </form>
  );
}
```

### Inline actions use `useTransition` + `useOptimistic`

For **immediate actions outside a form**, such as a checkbox toggle or delete button in a list, take a transition with `useTransition` and overlay `useOptimistic` on items whose state should be reflected immediately. It is a necessary condition that the `useOptimistic` setter be called **from within a transition**.

```tsx
// apps/web/app/components/todo/TodoItem.tsx
"use client";

import { useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useOptimistic, useState, useTransition } from "react";
import type { TodoView } from "@repo/core/application/todo/view";
import { displayError } from "@/presentation/errorDisplay";
import {
  extractSerializedError,
  type SerializedError,
} from "@/presentation/errorResponse";
import { changeTodoStatusFn, deleteTodoFn } from "./actions";

function todoErrorMessage(error: SerializedError): string {
  if (error.kind === "notFound") return "This Todo has already been deleted";
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
      <button type="button" onClick={onDelete} disabled={isPending}>Delete</button>
      {error !== null ? <span role="alert">{todoErrorMessage(error)}</span> : null}
    </li>
  );
}
```

### Failures such as Conflict

Failures such as `ConflictError` also ride the envelope and propagate to the client. On the UI side, `extractSerializedError(e)` in the action / transition `catch` and switch on `error.kind`:

```tsx
try {
  await changeStatus({ data: { id, status } });
} catch (e) {
  const error = extractSerializedError(e);
  if (error.kind === "notFound") setMessage("This Todo has already been deleted");
  else if (error.kind === "conflict") setMessage("Conflicted with another operation. Please try again");
  else setMessage(displayError(error));
}
```

### Points

- `useServerFn(fn)` auto-detects `isRedirect` and converts it into a router.navigate. This avoids falling through the client's try/catch when the usecase does `throw redirect({ to: "/login" })`.
- A `useActionState` action may be async. State updates both before and after `await` enter the same transition. Passing it to `<form action={formAction}>` lets it progressively enhance even on a client where JS has not yet arrived.
- When you want to update a loader-owned RSC on success, explicitly do `await router.invalidate()` inside the action / transition. Since the generic hook was abandoned, "when to invalidate" is the caller's responsibility.
- When you want to display `fieldErrors` **on a per-field basis**, just branch on `state.error?.kind === "validation"`. This form suffices without separately introducing Conform + `parseWithZod`. Since validation is consolidated on the server-side Zod, it arrives in the same `ValidationError` envelope no matter which entry point (server function / route loader / test) calls it.
- An item-local `useOptimistic` only works on **state that the item owns**. `TodoItem`'s `completed` toggle and `title` inline edit are both item-owned, so they are complete within the leaf with `useOptimistic` + server function (editing closes the editor immediately and optimistically displays the new title, and reverts automatically if the rename throws). On the other hand, operations that **change the list's membership**, such as add/remove, are parent state changes, so item-local cannot reach them. Carve the list out into a client island, hold the entire list array with `useOptimistic` seeded by the server value, and **have the owner call the server function** (the "Held by the client" section above / `apps/web/app/components/todo/TodoBoard`). Add optimistically prepends, remove filters, and `router.invalidate()` re-bases onto the settled value. Delete cannot be placed in the leaf because optimistic deletion unmounts the leaf before settlement, erasing the error UI along with it.

## Client validation with Conform

An example combining Conform's client validation + `useServerFn`.

```tsx
// apps/web/app/routes/posts/new.tsx
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
          toast.success("Post created");
          await router.navigate({
            to: "/posts/$postId",
            params: { postId },
          });
        } catch (e) {
          toast.error(e instanceof Error ? e.message : "Failed to create");
        }
      });
    },
  });

  return (
    <form {...getFormProps(form)}>
      <div>
        <label htmlFor={fields.title.id}>Title</label>
        <input {...getInputProps(fields.title, { type: "text" })} />
        <div className="text-destructive">{fields.title.errors}</div>
      </div>

      <div>
        <label htmlFor={fields.content.id}>Body</label>
        <textarea {...getTextareaProps(fields.content)} />
        <div className="text-destructive">{fields.content.errors}</div>
      </div>

      <button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create"}
      </button>
    </form>
  );
}
```

## Error / Not Found

Define `errorComponent` / `notFoundComponent` per route. Exceptions thrown inside a server component bubble up here.

```tsx
// apps/web/app/routes/index.tsx
export const Route = createFileRoute("/")({
  loader: async () => { /* ... */ },
  component: HomePage,
  errorComponent: ({ error }) => (
    <div role="alert">
      <h1>An error occurred</h1>
      <pre>{sanitizeRouteError(error)}</pre>
    </div>
  ),
});
```

The site-wide final fallback is the `errorComponent` / `notFoundComponent` in `apps/web/app/routes/__root.tsx`. The hierarchy is as follows:

```
Exception source (loader / server component / server function)
    ↓ throw
Matched child route .errorComponent  ←  stops here if defined
    ↓ if undefined, bubble up
__root.tsx .errorComponent          ←  final fallback (sanitizeRouteError)
```

`redirect()` / `notFound()` are caught by the router itself rather than the errorComponent, and are routed to navigation / `notFoundComponent` respectively.

### Propagating server function exceptions in structured form

An exception thrown by `createServerFn`'s `handler` reaches the client, but if it stays a plain `Error`, the `cause` chain and stack trace break during serialization, and branching by `kind` becomes impossible. So, in the presentation layer, we provide

- `AppServerError` — an exception class dedicated to propagation (holds `serialized` as an enumerable own property and survives a JSON round trip)
- `appServerErrorAdapter` (registered with `createStart` in `apps/web/app/start.ts`) — a serialization adapter that preserves the class identity of `AppServerError` across a Seroval roundtrip. **It runs only at boundaries via `createServerFn(...).middleware([errorResponseMiddleware])`**. Via direct `fetch` / an RSC error frame / a custom transport, the adapter does not run, and the client receives a plain Error/object (a remnant) that holds `serialized` as an own property
- `serializeError(error)` — folds Business / NotFound / Validation, etc. into a `SerializedError` (`{ kind, code, message, retryable?, fieldErrors? }`)
- `extractSerializedError(error)` — extracts the `SerializedError` on the client side. Three-stage detection: (1) `instanceof AppServerError` (the adapter-passed path) → (2) structural `serialized` remnant detection (the adapter-not-passed path) → (3) `serializeError` fallback. **UI code must always go through this function. Using `instanceof AppServerError` for branching becomes false on the adapter-not-passed path and breaks silently**
- `errorResponseMiddleware` (`apps/web/app/presentation/errorResponseMiddleware.ts`) — wraps the entire server function (both `inputValidator` and the handler) to apply the above and set the HTTP status from `SerializedErrorKind`. TanStack Router's `redirect()` / `notFound()` sentinels are rethrown as-is. **Write `createServerFn(...).middleware([errorResponseMiddleware])` directly at the call site** (pre-applying via a separate module is not allowed because it breaks the RSC plugin's static rewrite)

(`apps/web/app/presentation/errorResponse.ts`).

The side that raw-`await`s in a client action / transition / loader, etc. branches by kind with `extractSerializedError`:

```tsx
import { extractSerializedError } from "@/presentation/errorResponse";

try {
  await deleteTodo({ data: { id } });
} catch (e) {
  const { kind, message } = extractSerializedError(e);
  if (kind === "notFound") setErrorMessage("This Todo has already been deleted");
  else setErrorMessage(message);
}
```

`displayError` / `sanitizeRouteError` dispatch through a `Record<SerializedErrorKind, handler>`-typed table, so adding a new variant to `SerializedError.kind` produces a compile error. The aim is to guarantee exhaustiveness at the type level.

## Summary: must-haves for the current `@tanstack/react-start`

- Vite: the three-plugin setup of `tanstackStart({ srcDirectory: "app", rsc: { enabled: true } })` + `rsc()` (`@vitejs/plugin-rsc`) + `viteReact()`
- Server function validation: **`.inputValidator(...)`** (`.validator(...)` is the old API)
- RSC high-level APIs: `renderServerComponent` / `createCompositeComponent` / `CompositeComponent`
- server-only boundary: place `import "@tanstack/react-start/server-only";` at the top of the DI container and server helpers. Do not place it in server function definition files that client components import; enter the server-only side via a dynamic import inside the handler
- Calling a server function from the client: **wrap it with `useServerFn(fn)`** (with automatic redirect handling)
- Consolidate the server-side entry points that call usecases on the **`serverData` / `serverAction` wrappers**. Only one-line port-access helpers call `getContainer()` directly (escape hatch)
- `structuralSharing: false` is mandatory when putting RSC values into Query
- Low-level APIs (`renderToReadableStream` / `createFromReadableStream` / `createFromFetch`) only when a custom transport is needed
