import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { db } from "void/db";
import { kv } from "void/kv";

const getSmokeData = createServerFn().handler(async () => {
  const users = await db.list("users", { limit: 1 });
  const user = users[0] ?? null;

  await kv.set("smoke", "ok");
  const kvValue = await kv.get<string>("smoke");

  return { d1User: user, kvValue };
});

export const Route = createFileRoute("/smoke")({
  loader: () => getSmokeData(),
  component: SmokePage,
});

function SmokePage() {
  const data = Route.useLoaderData();

  return (
    <div style={{ padding: "16px" }}>
      <h1>Smoke Test</h1>
      <p>
        D1 user: <span data-testid="d1-user">{data.d1User?.name ?? "none"}</span>
      </p>
      <p>
        KV value: <span data-testid="kv-value">{data.kvValue ?? "none"}</span>
      </p>
    </div>
  );
}
