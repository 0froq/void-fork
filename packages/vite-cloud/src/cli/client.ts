import { getApiUrl } from "./auth";

export interface ProjectResponse {
  id: string;
  user_id: string;
  slug: string;
  mode: string;
  created_at: string;
  custom_domain: string | null;
}

export interface CreateProjectResponse {
  id: string;
  slug: string;
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
  commit: string | null;
  manifest: string | null;
  created_at: string;
  deployed_at: string | null;
}

export interface SecretResponse {
  ok: boolean;
  name: string;
}

export interface DomainResponse {
  id: string;
  project_id: string;
  hostname: string;
  cf_hostname_id: string;
  status: string;
  created_at: string;
  cname_target?: string;
}

export interface DomainStatusResponse extends DomainResponse {
  ssl_status: string;
  verification_errors?: string[];
}

/**
 * HTTP client for the Vite Cloud platform API.
 */
export class PlatformClient {
  private baseUrl: string;
  private token: string;

  constructor(token: string, apiUrl?: string) {
    this.token = token;
    this.baseUrl = apiUrl ?? getApiUrl();
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

  async createProject(slug: string): Promise<CreateProjectResponse> {
    const res = await fetch(`${this.baseUrl}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ slug }),
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

  async addDomain(projectId: string, hostname: string): Promise<DomainResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ hostname }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to add domain: ${res.status} ${body}`);
    }

    return res.json();
  }

  async listDomains(projectId: string): Promise<DomainResponse[]> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to list domains: ${res.status} ${body}`);
    }

    return res.json();
  }

  async getDomainStatus(projectId: string, domainId: string): Promise<DomainStatusResponse> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get domain status: ${res.status} ${body}`);
    }

    return res.json();
  }

  async removeDomain(projectId: string, domainId: string): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/projects/${projectId}/domains/${domainId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to remove domain: ${res.status} ${body}`);
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
