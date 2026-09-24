---
title: Stable Migration Execution
status: implemented
---

# Stable migration execution

Deploy-time application migrations use worker protocol v2. Build-time execution plans classify supported SQLite/D1 migration shapes, record SQL and plan hashes, and bind the plan list to the deployment. The worker verifies that metadata before execution. Breakpoint-framed D1 statements and their tracking insert execute in one D1 batch; durable attempt and lock records support reconciliation after uncertain outcomes.

The platform separates confirmed app migration results from the subsequent Better Auth phase and persists them even if later deployment steps fail. The remote D1 REST endpoint used by void db migrate --remote remains a legacy compensating path and does not claim the same atomic contract. Unsupported or legacy migration shapes are identified as such rather than silently treated as stable.

See [plan generation](../../../packages/void/src/migrations/plan.ts), [worker execution](../../../packages/void/src/runtime/migration-handler.ts), [platform plan verification](../../../platform/packages/api/src/migrations/execution-plan.ts), and [deployment orchestration](../../../platform/packages/api/src/routes/deploy.ts).
