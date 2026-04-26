export interface AiGatewayRequest {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
}

export interface AiGateway {
  getUrl(provider?: string): string | Promise<string>;
  run(request: AiGatewayRequest): Promise<Response>;
}

export interface AiBinding {
  run(
    model: string,
    inputs?: unknown,
    options?: Record<string, unknown>,
  ): Promise<ReadableStream | unknown>;
  gateway(id: string): AiGateway;
  models(inputs?: unknown): Promise<unknown>;
  toMarkdown(inputs?: unknown, options?: unknown): Promise<unknown>;
}

export type ProxyBody = Record<string, unknown>;

export interface Env {
  AI: AiBinding;
  JWT_SECRET: string;
  ROUTING: KVNamespace;

  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  API: Fetcher;
  DISPATCH: DispatchNamespace;
}

export interface JwtPayload {
  sub: string;
  login: string;
  aud: string;
  iat: number;
  exp: number;
}

export type ProxyEnv = {
  Bindings: Env;
  Variables: { projectId: string; body: ProxyBody };
};
