import { createFileRoute, Link } from "@tanstack/react-router";
import { buildHead } from "@/presentation/head";

export const Route = createFileRoute("/todo/about")({
  head: ({ match }) => {
    const config = match.context?.config;
    if (!config) return {};
    const { meta, links } = buildHead(config, { path: "/todo/about" });
    return { meta, links };
  },
  component: TodoAboutPage,
});

function TodoAboutPage() {
  return (
    <section>
      <h1>このテンプレについて</h1>
      <p>
        ヘッダー・サイドバーは親ルート（
        <code>apps/web/app/routes/todo/route.tsx</code>）の
        <code>component</code> に置いてある。<code>/todo</code> と{" "}
        <code>/todo/about</code>{" "}
        を行き来してもサイドバー開閉状態が保持されることを 確認してみて。
      </p>
      <p>
        各 leaf の loader が返す <code>renderServerComponent(...)</code> の
        payload に shell を含めると、遷移ごとに shell が RSC
        ツリーごと差し替わって再マウントされ、 クライアント状態が飛ぶ。leaf の
        RSC payload は leaf 固有のコンテンツだけにする。
      </p>
      <p>
        <Link to="/todo" search={{ page: 1, limit: 20 }}>
          一覧に戻る
        </Link>
      </p>
    </section>
  );
}
