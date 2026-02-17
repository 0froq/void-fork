const DEFAULT_API_URL = "https://api.vite.cloud";

export interface ProjectResponse {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  mode: string;
  created_at: string;
}

export interface CreateProjectResponse {
  id: string;
  slug: string;
  name: string;
}

export interface DeployResponse {
  deployment: string;
  url: string;
  assets: number;
  workers: number;
  migrations?: number;
}

export interface DeleteProjectResponse {
  ok: boolean;
  id: string;
  slug: string;
  warnings?: string[];
}

export interface DeploymentResponse {
  id: string;
  status: string;
  source: string | null;
  manifest: string | null;
  created_at: string;
  deployed_at: string | null;
}

export interface SecretResponse {
  ok: boolean;
  name: string;
}

/**
 * HTTP client for the Vite Cloud platform API.
 */
export class PlatformClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string, apiUrl?: string) {
    this.token = token;
    this.baseUrl = apiUrl ?? process.env.VITE_CLOUD_API_URL ?? DEFAULT_API_URL;
  }

  async whoami(): Promise<{ login: string }> {
    const res = await fetch(`${this.baseUrl}/me`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to fetch user info: ${res.status} ${body}`);
    }

    return res.json();
  }

  async listProjects(): Promise<ProjectResponse[]> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to list projects: ${res.status} ${body}`);
    }

    return res.json();
  }

  async listDeployments(projectId: string): Promise<DeploymentResponse[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/deployments`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to list deployments: ${res.status} ${body}`);
    }

    return res.json();
  }

  async createProject(slug: string, name: string): Promise<CreateProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ slug, name }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to create project: ${res.status} ${body}`);
    }

    return res.json();
  }

  async checkAssets(projectId: string, assets: Record<string, string>): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/assets/check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ assets }),
    });

    if (!res.ok) {
      if (res.status === 404) return Object.keys(assets); // fallback: upload all
      throw new Error(`Asset check failed: ${res.status}`);
    }

    return ((await res.json()) as { needed: string[] }).needed;
  }

  async deploy(projectId: string, formData: FormData): Promise<DeployResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/deploy`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Deploy failed: ${res.status} ${body}`);
    }

    return res.json();
  }

  async setSecret(projectId: string, name: string, value: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify({ value }),
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to set secret: ${res.status} ${body}`);
    }

    return res.json();
  }

  async deleteProject(projectId: string): Promise<DeleteProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to delete project: ${res.status} ${body}`);
    }

    return res.json();
  }

  async getMigrationStatus(
    projectId: string,
  ): Promise<{ applied: { name: string; applied_at: string }[] }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/migrations`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get migration status: ${res.status} ${body}`);
    }

    return res.json();
  }

  async deleteSecret(projectId: string, name: string): Promise<SecretResponse> {
    const res = await fetch(
      `${this.baseUrl}/projects/${projectId}/secrets/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${this.token}`,
        },
      },
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to delete secret: ${res.status} ${body}`);
    }

    return res.json();
  }
}
