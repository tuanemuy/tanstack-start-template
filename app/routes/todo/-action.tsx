import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { errorResponseMiddleware } from "@/core/presentation/errorResponseMiddleware";
import { paginationSchema } from "@/core/presentation/pagination";
import { validateInput } from "@/core/presentation/validator";

export const renderTodoList = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(paginationSchema))
  .handler(async ({ data }) => {
    const { TodoList } = await import("@/components/todo/TodoList");
    // Wrap leaf content only — shared shell (Header/Sidebar) lives in the
    // parent route's `component`, never inside this RSC payload.
    //
    // Return the UNRESOLVED RSC payload promise so the route loader can forward
    // it without awaiting: navigation settles immediately and the list streams
    // in under <Suspense fallback={<TodoListSkeleton/>}>. Await it here (or in
    // the loader) and you collapse back to a blocking render — no skeleton.
    return { TodoList: renderServerComponent(<TodoList pagination={data} />) };
  });
