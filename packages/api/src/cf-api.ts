export async function deleteDispatchScript(
  accountId: string,
  apiToken: string,
  namespace: string,
  scriptName: string,
): Promise<void> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    },
  );
  if (!res.ok && res.status !== 404) {
    console.error(`Failed to delete dispatch script ${scriptName}: ${res.status}`);
  }
}
