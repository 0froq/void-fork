const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";
const PREVIEW_REPO_OWNER = "void-sdk";
const PREVIEW_REPO_NAME = "void";
const PREVIEW_REPO_PERMISSION = "pull";

export type GitHubPreviewRepoConfig = {
  pat: string;
};

type RepositoryInvitation = {
  id: number;
  invitee: { login: string } | null;
};

export function getGitHubPreviewRepoConfig(env: {
  GITHUB_PREVIEW_REPO_PAT?: string;
}): GitHubPreviewRepoConfig | null {
  const pat = env.GITHUB_PREVIEW_REPO_PAT?.trim();

  return pat ? { pat } : null;
}

export async function ensureGitHubPreviewRepoAccess(
  config: GitHubPreviewRepoConfig,
  username: string,
): Promise<void> {
  const login = username.trim();
  if (!login) return;

  const collaboratorUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(PREVIEW_REPO_OWNER)}/${encodeURIComponent(PREVIEW_REPO_NAME)}/collaborators/${encodeURIComponent(login)}`;
  const collaboratorRes = await githubRequest(config.pat, collaboratorUrl);

  if (collaboratorRes.status === 204) {
    return;
  }

  if (collaboratorRes.status !== 404) {
    throw new Error(
      `Collaborator check failed: ${collaboratorRes.status} ${await readErrorBody(collaboratorRes)}`,
    );
  }

  const invitationsUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(PREVIEW_REPO_OWNER)}/${encodeURIComponent(PREVIEW_REPO_NAME)}/invitations`;
  const invitationsRes = await githubRequest(config.pat, invitationsUrl);
  if (!invitationsRes.ok) {
    throw new Error(
      `Invitation list failed: ${invitationsRes.status} ${await readErrorBody(invitationsRes)}`,
    );
  }

  const invitations = (await invitationsRes.json()) as RepositoryInvitation[];
  const hasPendingInvite = invitations.some(
    (invitation) => invitation.invitee?.login?.toLowerCase() === login.toLowerCase(),
  );
  if (hasPendingInvite) {
    return;
  }

  const inviteRes = await githubRequest(config.pat, collaboratorUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permission: PREVIEW_REPO_PERMISSION }),
  });

  if (inviteRes.status === 201 || inviteRes.status === 204) {
    return;
  }

  throw new Error(`Invite failed: ${inviteRes.status} ${await readErrorBody(inviteRes)}`);
}
function githubRequest(pat: string, url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${pat}`);
  headers.set("User-Agent", "void-api");
  headers.set("X-GitHub-Api-Version", GITHUB_API_VERSION);

  return fetch(url, { ...init, headers });
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.trim() || "<empty>";
  } catch {
    return "<unreadable>";
  }
}
