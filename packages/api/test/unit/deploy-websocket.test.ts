import { describe, expect, it } from "vitest";
import { enrichWebSocketManifest } from "../../src/routes/deploy";
import type { DeployManifest } from "../../src/types";

describe("enrichWebSocketManifest", () => {
  it("reuses previous websocket migrations when class sets are unchanged", () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: "/chat/:room",
            filePath: "chat/[room].ws.ts",
            className: "ChatRoom",
            mode: "room",
            hasAuthGate: true,
          },
        ],
        classes: ["ChatRoom"],
        migrations: [{ tag: "ws-v1", newClasses: ["ChatRoom"] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: "/chat/:room",
              filePath: "chat/[room].ws.ts",
              className: "ChatRoom",
              mode: "room",
              hasAuthGate: true,
            },
          ],
          classes: ["ChatRoom", "ChatRoom"],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(["ChatRoom"]);
    expect(result.manifest.websocket?.migrations).toEqual(previousManifest.websocket?.migrations);
  });

  it("appends websocket migrations when durable object classes change", () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: "/chat/:room",
            filePath: "chat/[room].ws.ts",
            className: "ChatRoom",
            mode: "room",
            hasAuthGate: true,
          },
        ],
        classes: ["ChatRoom", "LegacyRoom"],
        migrations: [{ tag: "ws-v1", newClasses: ["ChatRoom", "LegacyRoom"] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: "/chat/:room",
              filePath: "chat/[room].ws.ts",
              className: "ChatRoom",
              mode: "room",
              hasAuthGate: true,
            },
          ],
          classes: ["PresenceRoom", "ChatRoom"],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(["ChatRoom", "PresenceRoom"]);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: "ws-v1", newClasses: ["ChatRoom", "LegacyRoom"] },
      { tag: "ws-v2", newClasses: ["PresenceRoom"], deletedClasses: ["LegacyRoom"] },
    ]);
  });
});
