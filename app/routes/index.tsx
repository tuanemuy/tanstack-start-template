import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";

function Greeting() {
  return <h1>Home</h1>;
}

const getGreeting = createServerFn().handler(async () => {
  const Renderable = await renderServerComponent(<Greeting />);
  return { Renderable };
});

export const Route = createFileRoute("/")({
  loader: async () => {
    const { Renderable } = await getGreeting();
    return { Greeting: Renderable };
  },
  component: HomePage,
});

function HomePage() {
  const { Greeting } = Route.useLoaderData();
  return <>{Greeting}</>;
}
