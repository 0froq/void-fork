interface Env {
  ANALYTICS: AnalyticsEngineDataset;
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
    }
  },
} satisfies ExportedHandler<Env>;
