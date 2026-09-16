import { randomBytes } from 'node:crypto';

export const STAGING_API = 'https://api.staging.void.cloud';
const PROJECT_SLUG = 'kitchen-sink';

type Secret = { name: string; value: string };
type Client = {
  apiUrl: string;
  listProjects(): Promise<Array<{ id: string; slug: string }>>;
  listSecrets(projectId: string): Promise<Array<{ name: string }>>;
  setSecret(projectId: string, name: string, value: string): Promise<unknown>;
};

/** Fill only missing staging fixture values; never import a developer's .env. */
export async function initializeStagingEnv(
  client: Client,
  validate: (entries: Array<Secret>) => Promise<void>,
): Promise<Array<string>> {
  if (client.apiUrl !== STAGING_API) {
    throw new Error('Kitchen-sink fixture setup requires the staging API.');
  }
  const projects = (await client.listProjects()).filter((project) => project.slug === PROJECT_SLUG);
  if (projects.length !== 1) {
    throw new Error(
      'Kitchen-sink fixture setup requires exactly one existing kitchen-sink project.',
    );
  }
  const projectId = projects[0].id;
  const existing = new Set((await client.listSecrets(projectId)).map((secret) => secret.name));
  const entries: Array<Secret> = [];
  for (const name of ['APP_NAME', 'SECRET_KEY', 'API_URL']) {
    if (!existing.has(name)) {
      entries.push({
        name,
        value:
          name === 'SECRET_KEY'
            ? Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('')
            : name === 'APP_NAME'
              ? 'Kitchen Sink'
              : 'https://api.example.com',
      });
    }
  }
  if (entries.length === 0) {
    return [];
  }
  // Validate the whole batch before any write, like `void secret sync`.
  await validate(entries);
  for (const { name, value } of entries) {
    await client.setSecret(projectId, name, value);
  }
  return entries.map(({ name }) => name);
}
