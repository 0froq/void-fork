import { renderToString } from "react-dom/server";
import { defineRender } from "vite-cloud";
import App from "./App";

export default defineRender(async (c, assetTags) => {
  const url = new URL(c.req.url);
  const currentCount = Number((await c.env.KV.get("ssr:visits")) ?? "0");
  const nextCount = currentCount + 1;
  await c.env.KV.put("ssr:visits", String(nextCount));

  const appHtml = renderToString(<App url={url.pathname} visitCount={nextCount} />);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vite Cloud SSR Playground</title>
    <script>window.__STATE__={ visits: ${nextCount} }</script>
    ${assetTags.head}
  </head>
  <body>
    <div id="root">${appHtml}</div>
    ${assetTags.body}
  </body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  });
});
