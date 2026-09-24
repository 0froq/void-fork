---
title: Real-Time 5xx Error Alerting
status: implemented
---

# Real-time 5xx error alerting

Dispatch includes 5xx status in usage events. After the usage queue processes a batch, it sends project error counts to a per-project ErrorAlertMonitor Durable Object. The monitor accumulates a window, waits two minutes for a burst, and alerts immediately at 100 errors. A 24-hour cooldown limits repeated mail.

The monitor persists count and error-window bounds. A transient email failure keeps the count and schedules a retry; a missing recipient address clears it. The system uses the existing usage queue and installation email binding. See [queue routing](../../packages/api/src/usage-queue.ts), [monitor](../../packages/api/src/error-alert-monitor.ts), and [alert email](../../packages/api/src/email.ts).
