import type { ErrorHandler } from 'hono';
import type { ApiEnv } from '../env.ts';
import { OperatorError } from '../operator/common.ts';
import { getPlatformPageTitle } from '../platform-identity.ts';

/** Browser and JSON clients share operations, while keeping their own rendering. */
export const renderOperationError: ErrorHandler<ApiEnv> = (error, context) => {
  if (!(error instanceof OperatorError)) {
    throw error;
  }
  return context.html(
    <>
      <title>{getPlatformPageTitle('Admin error', context.env, context.req.url)}</title>
      <h1>{error.message}</h1>
      <p>
        {error.status === 401 ? (
          <a href="/admin/logout">Sign in again</a>
        ) : (
          <a href="/admin/">Return to admin</a>
        )}
      </p>
    </>,
    error.status,
  );
};
