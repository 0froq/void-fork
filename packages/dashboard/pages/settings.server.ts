import { defineHandler } from "vite-cloud";
import { api } from "../lib/api";

interface UserProfile {
  id: string;
  login: string;
  email: string | null;
  provider: string;
  plan: string;
  billing_cycle_start: string;
  limits: {
    requestsPerMonth: number;
    deploysPerDay: number;
    d1StorageBytes: number;
    r2StorageBytes: number;
    kvStorageBytes: number;
    aiNeuronsPerMonth: number;
  };
}

export interface Props {
  user: UserProfile;
}

export const loader = defineHandler<Props>(async (c) => {
  const user = await api<UserProfile>(c, "/me");
  return { user };
});
