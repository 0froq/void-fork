import type { BuildManager } from '../build-manager.ts';
import type { ApiEnv } from '../env.ts';
import type { Build } from '../types.ts';

/**
 * Best-effort stop the BuildManager DO for each cancelled CONTAINER build.
 *
 * Terminalizing the build row (→ `cancelled`) is what actually revokes its
 * deploy token: the middleware guard rejects any deploy token whose bound
 * build is no longer in `ACTIVE_BUILD_STATUSES`. This step is a non-security
 * cleanup that also tears down the still-running container so it stops billing.
 *
 * Called AFTER the DB transaction commits — never while holding a row lock — so
 * an external DO round-trip can't extend the lock hold across the network. A
 * never-started queued container build has no live DO, so its `cancelBuild()` is
 * a harmless no-op. `github_actions` builds have no DO and are skipped here:
 * terminalizing their row is what revokes their token. Failures are swallowed:
 * the token is already revoked by the committed status flip.
 *
 * Uses the trusted `cancelBuild` RPC on BuildManager (NOT the agent-authenticated
 * POST /cancel — that secret is minted inside the DO and unavailable here). The
 * RPC tears down the orphaned container so it stops billing; without it a
 * 0/unlimited-plan build (no timeout alarm) could run far past any sane ceiling.
 */
export async function cancelContainerBuildDos(
  env: ApiEnv['Bindings'],
  cancelled: ReadonlyArray<{ id: string; executor: Build['executor'] }>,
  reason = 'build cancelled',
): Promise<void> {
  for (const build of cancelled) {
    if (build.executor !== 'container') {
      continue;
    }
    try {
      const stub = env.BUILD_MANAGER.get(
        env.BUILD_MANAGER.idFromName(build.id),
      ) as unknown as DurableObjectStub<BuildManager>;
      await stub.cancelBuild(reason);
    } catch (err) {
      console.warn(`[github] best-effort cancel of build ${build.id} failed:`, err);
    }
  }
}
