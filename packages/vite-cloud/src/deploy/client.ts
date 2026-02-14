const DEFAULT_API_URL = "https://vite-cloud-platform.workers.dev";

export interface ProjectResponse {
  id: string;
  user_id: string;
  slug: string;
  name: string;
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
}
