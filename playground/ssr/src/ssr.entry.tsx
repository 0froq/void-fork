import { renderToString } from "react-dom/server";
import App from "./App";

export async function render(request: Request, env: { KV: KVNamespace }): Promise<Response> {
  const url = new URL(request.url);
  const currentCount = Number((await env.KV.get("ssr:visits")) ?? "0");
  const nextCount = currentCount + 1;
  await env.KV.put("ssr:visits", String(nextCount));

  const appHtml = renderToString(<App url={url.pathname} visitCount={nextCount} />);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite Cloud SSR Playground</title>
    <script>window.__STATE__={ visits: ${nextCount} }</script>
  </head>
  <body>
    <div id="root">${appHtml}</div>
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}
