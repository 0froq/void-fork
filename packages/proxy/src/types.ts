export interface Env {
  AI: Ai;
  JWT_SECRET: string;
  ROUTING: KVNamespace;
  DB: D1Database;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  API: Fetcher;
}

export interface JwtPayload {
  sub: string;
  login: string;
  iat: number;
  exp: number;
}

export type ProxyEnv = {
  Bindings: Env;
  Variables: { projectId: string; body: Record<string, any> };
};
