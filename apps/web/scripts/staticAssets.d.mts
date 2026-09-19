export function withStaticAssets(
  serverEntry: string,
  fetch: (request: Request) => Promise<Response>,
): (request: Request) => Response | Promise<Response>;
