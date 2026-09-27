/** @jsxImportSource @voidcloud/api/admin-jsx */
import type { PlatformLoginConfiguration } from '@void/platform';
const HOME = '/admin/config/auth';
export function ConnectionForm({
  configuration,
  revision,
  callbackUrl,
}: {
  configuration: Partial<PlatformLoginConfiguration> & {
    id: string;
    kind: PlatformLoginConfiguration['kind'];
  };
  revision: number | null;
  callbackUrl: string;
}) {
  return (
    <form
      method="post"
      action={`${HOME}/connections/${encodeURIComponent(configuration.id)}/configure`}
      style="display: grid; gap: 12px; max-width: 700px"
    >
      <input type="hidden" name="id" value={configuration.id} />
      <input type="hidden" name="kind" value={configuration.kind} />
      <input type="hidden" name="revision" value={revision ?? ''} />
      <p>Register this callback URL with the provider:</p>
      <pre>{callbackUrl}</pre>
      <label>
        Connection ID{' '}
        <input
          name="connectionId"
          value={configuration.id}
          readonly={
            revision !== null || configuration.kind === 'github' || configuration.kind === 'google'
          }
          required
        />
      </label>
      <label>
        Login button label{' '}
        <input name="label" value={configuration.label ?? ''} required maxlength={100} />
      </label>
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <label>
          Issuer URL <input name="issuer" type="url" value={configuration.issuer ?? ''} required />
        </label>
      )}
      <label>
        Client ID <input name="clientId" value={configuration.clientId ?? ''} required />
      </label>
      <label>
        Client secret{' '}
        <input
          name="clientSecret"
          type="password"
          autocomplete="new-password"
          required={revision === null}
        />
      </label>
      {revision !== null && <p>Leave the secret blank to retain its saved value.</p>}
      {configuration.kind === 'google' && (
        <label>
          Allowed Workspace domains{' '}
          <input
            name="domains"
            value={configuration.allowedDomains?.join(', ') ?? ''}
            placeholder="example.com, example.org"
          />
          <small>
            {' '}
            Leave blank to allow any Google account to authenticate. Signup remains controlled
            separately.
          </small>
        </label>
      )}
      {(configuration.kind === 'oidc' || configuration.kind === 'cloudflare-access') && (
        <label>
          Allowed groups{' '}
          <input name="groups" value={configuration.requiredGroups?.join(', ') ?? ''} />
          <small> Comma-separated; leave blank to use the provider's access policy.</small>
        </label>
      )}
      <p>Save a pending configuration, then test it before enabling it.</p>
      <button type="submit">Save configuration</button>
    </form>
  );
}
