export default defineEventHandler(async (event) => {
  const { env } = event.context.cloudflare;

  const result = await env.DB.prepare("SELECT * FROM users LIMIT 1").first();

  await env.KV.put("smoke", "ok");
  const kvValue = await env.KV.get("smoke");

  return { user: result, kvValue };
});
