---
title: Scroll Position Restoration
status: implemented
---

# Scroll position restoration

The Pages navigation engine uses manual browser history scroll restoration. Before a client navigation, it saves the outgoing entry's scroll coordinates. A new visit normally scrolls to the top unless preserveScroll is requested; back and forward visits restore the saved coordinates.

Hash fragments remain in navigation URLs, and same-page hash navigation can move to its target without fetching page data. Scroll restoration is implemented in the shared [navigation engine](../../../packages/void/src/pages/navigation-engine.ts), with options exposed by the [Pages client](../../../packages/void/src/pages/client.ts).
