/** A concrete destination that can execute a Void deployment. */
export type DeployTarget = 'cloudflare' | 'void';

/** Cross-target deploy modes whose support affects CLI planning. */
export type DeployTargetCapabilities = {
  managedProjects: boolean;
  staticDeploys: boolean;
  skipBuild: boolean;
};

/**
 * Boundary implemented by deployment targets.
 *
 * Build classification and packaging stay outside the adapter; provider
 * credentials, resource names, remote ids, and execution stay inside it.
 */
export type DeployTargetAdapter<TOptions, TContext> = {
  readonly target: DeployTarget;
  readonly capabilities: DeployTargetCapabilities;
  deploy(root: string, options: TOptions, context: TContext): Promise<void>;
};
