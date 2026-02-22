import { defineHandler } from "vite-cloud";
import { api } from "../lib/api";

interface Project {
  id: string;
  slug: string;
  mode: string;
  custom_domain: string | null;
  created_at: string;
}

interface Usage {
  billingPeriodStart: string;
  requests: number;
  bandwidthBytes: number;
  aiNeurons: number;
  projects: { projectId: string; slug: string; requests: number }[];
}

export interface Props {
  projects: Project[];
  usage: Usage;
}

export const loader = defineHandler<Props>(async (c) => {
  const [projects, usage] = await Promise.all([
    api<Project[]>(c, "/projects"),
    api<Usage>(c, "/usage"),
  ]);
  return { projects, usage };
});
