import { describe, expect, it } from 'vitest';
import {
  buildWebSocketUploadBindings,
  buildWebSocketUploadMigrations,
  enrichWebSocketManifest,
} from '../../src/routes/deploy';
import type { DeployManifest } from '../../src/types';

describe('enrichWebSocketManifest', () => {
  it('reuses previous websocket migrations when class sets are unchanged', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [
          {
            pattern: '/chat/:room',
            filePath: 'chat/[room].ws.ts',
            className: 'ChatRoom',
            mode: 'room',
            hasAuthGate: true,
          },
        ],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [
            {
              pattern: '/chat/:room',
              filePath: 'chat/[room].ws.ts',
              className: 'ChatRoom',
              mode: 'room',
              hasAuthGate: true,
            },
          ],
          classes: ['ChatRoom', 'ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(false);
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual(previousManifest.websocket?.migrations);
  });

  it('appends migration when a genuinely new class is added', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newClasses: ['PresenceRoom'] },
    ]);
  });

  it('does not emit deletedClasses when classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom', 'LegacyRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'],
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — no migration step needed (no new classes)
    expect(result.nextVersion).toBe(1);
    // Class list updated but no new migration appended
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
    ]);
  });

  it('does not emit deletedClasses when all classes are removed', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest({ version: 3, bindings: {} }, previousManifest, 1);

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // No new migration — nothing for CF to do
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
    expect(result.manifest.websocket?.classes).toEqual([]);
  });

  it('does not re-emit newClasses for a class that was previously created then removed', () => {
    // Scenario: class created in v1, removed in deploy 2, re-added in deploy 3
    // The class namespace already exists in CF — must NOT appear in newClasses again
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [], // was removed in a previous deploy
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-added
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    // No version bump — ChatRoom already exists in CF from ws-v1
    expect(result.nextVersion).toBe(1);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom']);
    // No new migration step — ChatRoom is not "new"
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
    ]);
  });

  it('only emits newClasses for genuinely new classes when mixed with returning classes', () => {
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [{ tag: 'ws-v1', newClasses: ['ChatRoom'] }],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'], // ChatRoom returns, PresenceRoom is new
          migrations: [],
        },
      },
      previousManifest,
      1,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(2);
    expect(result.manifest.websocket?.classes).toEqual(['ChatRoom', 'PresenceRoom']);
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', newClasses: ['PresenceRoom'] },
    ]);
  });

  it('falls back to previousClasses when migration history is absent (legacy projects)', () => {
    // Legacy project: classes exist in CF but no migration history was recorded
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: ['ChatRoom'],
        migrations: [], // no history — predates the migration system
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom', 'PresenceRoom'],
          migrations: [],
        },
      },
      previousManifest,
      0,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(1);
    // Only PresenceRoom is new — ChatRoom already exists (from previousClasses fallback)
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['PresenceRoom'] },
    ]);
  });

  it('re-creates a class that was previously deleted via legacy deletedClasses', () => {
    // Legacy project had a class created then deleted (old behavior).
    // The namespace was actually destroyed — must re-create it.
    const previousManifest: DeployManifest = {
      version: 3,
      bindings: {},
      websocket: {
        routes: [],
        classes: [],
        migrations: [
          { tag: 'ws-v1', newClasses: ['ChatRoom'] },
          { tag: 'ws-v2', deletedClasses: ['ChatRoom'] }, // namespace was destroyed
        ],
      },
    };

    const result = enrichWebSocketManifest(
      {
        version: 3,
        bindings: {},
        websocket: {
          routes: [],
          classes: ['ChatRoom'], // re-adding after deletion
          migrations: [],
        },
      },
      previousManifest,
      2,
    );

    expect(result.changed).toBe(true);
    expect(result.nextVersion).toBe(3);
    // ChatRoom must appear in newClasses because its namespace was deleted
    expect(result.manifest.websocket?.migrations).toEqual([
      { tag: 'ws-v1', newClasses: ['ChatRoom'] },
      { tag: 'ws-v2', deletedClasses: ['ChatRoom'] },
      { tag: 'ws-v3', newClasses: ['ChatRoom'] },
    ]);
  });
});

describe('buildWebSocketUploadMigrations', () => {
  it('returns Cloudflare upload metadata with new_tag and steps', () => {
    expect(
      buildWebSocketUploadMigrations([
        { tag: 'ws-v1', newClasses: ['ChatRoom', 'LegacyRoom'] },
        { tag: 'ws-v2', newClasses: ['PresenceRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['ChatRoom', 'LegacyRoom'] }, { new_classes: ['PresenceRoom'] }],
    });
  });

  it('strips deleted_classes from legacy migration data', () => {
    // Old migration data may still contain deletedClasses from before the fix.
    // buildWebSocketUploadMigrations should not pass them to Cloudflare.
    expect(
      buildWebSocketUploadMigrations([
        { tag: 'ws-v1', newClasses: ['ChatRoom'] },
        { tag: 'ws-v2', deletedClasses: ['ChatRoom'] },
      ]),
    ).toEqual({
      new_tag: 'ws-v2',
      steps: [{ new_classes: ['ChatRoom'] }, {}],
    });
  });

  it('returns undefined when there are no websocket migrations', () => {
    expect(buildWebSocketUploadMigrations([])).toBeUndefined();
    expect(buildWebSocketUploadMigrations(undefined)).toBeUndefined();
  });
});

describe('buildWebSocketUploadBindings', () => {
  it('serializes durable object namespaces from websocket routes', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [
          {
            pattern: '/ws/chat/:room',
            filePath: 'routes/ws/chat/[room].ws.ts',
            className: 'WsChatRoomWs',
            bindingName: 'CHAT_ROOM',
            mode: 'room',
            hasAuthGate: false,
          },
          {
            pattern: '/ws/presence',
            filePath: 'routes/ws/presence.ws.ts',
            className: 'WsPresenceWs',
            mode: 'socket',
            hasAuthGate: false,
          },
        ],
        classes: ['WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'CHAT_ROOM',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });

  it('falls back to class names when route metadata is unavailable', () => {
    expect(
      buildWebSocketUploadBindings({
        routes: [],
        classes: ['WsPresenceWs', 'WsChatRoomWs', 'WsPresenceWs'],
      }),
    ).toEqual([
      {
        type: 'durable_object_namespace',
        name: 'WsChatRoomWs',
        class_name: 'WsChatRoomWs',
      },
      {
        type: 'durable_object_namespace',
        name: 'WsPresenceWs',
        class_name: 'WsPresenceWs',
      },
    ]);
  });
});
