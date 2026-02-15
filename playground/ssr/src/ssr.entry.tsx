import { renderToReadableStream } from "react-dom/server";
import App from "./App";

export async function render(request: Request, env: { KV: KVNamespace }): Promise<Response> {
  const url = new URL(request.url);
  const visitCount = ((await env.KV.get("ssr:visits")) ?? "0") as string;
  await env.KV.put("ssr:visits", String(Number(visitCount) + 1));

  const stream = await renderToReadableStream(<App url={url.pathname} />);
  return new Response(stream, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
}
