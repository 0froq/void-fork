import { createServer } from "node:net";
import { once } from "node:events";
import type { spawn } from "node:child_process";

/**
 * Returns an unused port by briefly binding to port 0 and reading the
 * OS-assigned port.
 */
export async function getPort(): Promise<number> {
  const server = createServer();
  server.listen(0);
  await once(server, "listening");
  const { port } = server.address() as import("node:net").AddressInfo;
  server.close();
  await once(server, "close");
  return port;
}

export async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.status > 0) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

export async function killChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}
