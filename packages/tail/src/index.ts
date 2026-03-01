interface Env {
  ANALYTICS: AnalyticsEngineDataset;
  LOG_STREAM: DurableObjectNamespace;
}

function isFetchEvent(event: TraceItem["event"]): event is TraceItemFetchEventInfo {
  return event !== null && "request" in event;
}

export default {
  async tail(events: TraceItem[], env: Env) {
    for (const event of events) {
      const scriptName = event.scriptName;
      if (!scriptName?.startsWith("user-")) continue;

      const fetchEvent = isFetchEvent(event.event) ? event.event : null;

      env.ANALYTICS.writeDataPoint({
        indexes: [scriptName],
        blobs: [
          event.outcome,
          JSON.stringify(event.logs),
          JSON.stringify(event.exceptions),
          fetchEvent?.request.url ?? "",
          fetchEvent?.request.method ?? "",
          String(fetchEvent?.response?.status ?? ""),
        ],
        doubles: [event.eventTimestamp ?? Date.now(), fetchEvent?.response?.status ?? 0],
      });

      // Forward to LogStream DO for live tailing
      const id = env.LOG_STREAM.idFromName(scriptName);
      const stub = env.LOG_STREAM.get(id);
      void stub.fetch("http://do/event", {
        method: "POST",
        body: JSON.stringify({
          scriptName,
          outcome: event.outcome,
          eventTimestamp: event.eventTimestamp,
          logs: event.logs,
          exceptions: event.exceptions,
          url: fetchEvent?.request.url,
          method: fetchEvent?.request.method,
          status: fetchEvent?.response?.status,
        }),
      });
    }
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/tail\/(.+)$/);
    if (!match) {
      return new Response("Not found", { status: 404 });
    }

    const scriptName = match[1];
    const id = env.LOG_STREAM.idFromName(scriptName);
    const stub = env.LOG_STREAM.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class LogStream implements DurableObject {
  constructor(
    private ctx: DurableObjectState,
    private _env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Internal: receive events from tail handler
    if (request.method === "POST" && url.pathname === "/event") {
      const event = await request.json();
      this.broadcast(event);
      return new Response("ok");
    }

    // External: WebSocket upgrade for live tailing
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage() {
    // Clients are read-only — ignore incoming messages
  }

  webSocketClose() {
    // Hibernation handles cleanup automatically
  }

  private broadcast(event: unknown) {
    const data = JSON.stringify(event);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // WebSocket already closed — ignore
      }
    }
  }
}
