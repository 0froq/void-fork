import { describe, expect, it } from "vitest";
import {
  buildWebSocketUploadBindings,
  buildWebSocketUploadMigrations,
  enrichWebSocketManifest,
} from "../../src/routes/deploy";
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

describe("buildWebSocketUploadMigrations", () => {
  it("returns Cloudflare upload metadata with new_tag and steps", () => {
    expect(
      buildWebSocketUploadMigrations([
        { tag: "ws-v1", newClasses: ["ChatRoom", "LegacyRoom"] },
        { tag: "ws-v2", newClasses: ["PresenceRoom"], deletedClasses: ["LegacyRoom"] },
      ]),
    ).toEqual({
      new_tag: "ws-v2",
      steps: [
        { new_classes: ["ChatRoom", "LegacyRoom"] },
        { new_classes: ["PresenceRoom"], deleted_classes: ["LegacyRoom"] },
      ],
    });
  });

  it("returns undefined when there are no websocket migrations", () => {
    expect(buildWebSocketUploadMigrations([])).toBeUndefined();
    expect(buildWebSocketUploadMigrations(undefined)).toBeUndefined();
  });
});

describe("buildWebSocketUploadBindings", () => {
  it("serializes durable object namespaces from websocket routes", () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [
          {
            pattern: "/ws/chat/:room",
            filePath: "routes/ws/chat/[room].ws.ts",
            className: "WsChatRoomWs",
            bindingName: "CHAT_ROOM",
            mode: "room",
            hasAuthGate: false,
          },
          {
            pattern: "/ws/presence",
            filePath: "routes/ws/presence.ws.ts",
            className: "WsPresenceWs",
            mode: "socket",
            hasAuthGate: false,
          },
        ],
        classes: ["WsChatRoomWs", "WsPresenceWs"],
      }),
    ).toEqual([
      {
        type: "durable_object_namespace",
        name: "CHAT_ROOM",
        class_name: "WsChatRoomWs",
      },
      {
        type: "durable_object_namespace",
        name: "WsPresenceWs",
        class_name: "WsPresenceWs",
      },
    ]);
  });

  it("falls back to class names when route metadata is unavailable", () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [],
        classes: ["WsPresenceWs", "WsChatRoomWs", "WsPresenceWs"],
      }),
    ).toEqual([
      {
        type: "durable_object_namespace",
        name: "WsChatRoomWs",
        class_name: "WsChatRoomWs",
      },
      {
        type: "durable_object_namespace",
        name: "WsPresenceWs",
        class_name: "WsPresenceWs",
      },
    ]);
  });
});
