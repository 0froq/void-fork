import { renderToReadableStream } from "react-dom/server";
import App from "./App";

export async function render(request: Request, env: { KV: KVNamespace }): Promise<Response> {
  const url = new URL(request.url);
  const currentCount = Number((await env.KV.get("ssr:visits")) ?? "0");
  const nextCount = currentCount + 1;
  await env.KV.put("ssr:visits", String(nextCount));

  const stream = await renderToReadableStream(<App url={url.pathname} visitCount={nextCount} />);
  return new Response(stream, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}
