export type AiGatewayRequest = {
  provider: string;
  endpoint: string;
  headers: Record<string, string>;
  query: unknown;
};

export type AiGateway = {
  getUrl(provider?: string): string | Promise<string>;
  run(request: AiGatewayRequest): Promise<Response>;
};

export type AiBinding = {
  run(
    model: string,
    inputs?: unknown,
    options?: Record<string, unknown>,
  ): Promise<ReadableStream | unknown>;
  gateway(id: string): AiGateway;
  models(inputs?: unknown): Promise<unknown>;
  toMarkdown(inputs?: unknown, options?: unknown): Promise<unknown>;
};

export type ProxyBody = Record<string, unknown>;

export type Env = {
  AI: AiBinding;
  JWT_SECRET: string;
  ROUTING: KVNamespace;

  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  API: Fetcher;
  DISPATCH: DispatchNamespace;
};

export type JwtPayload = {
  sub: string;
  login: string;
  aud: string;
  iat: number;
  exp: number;
};

export type ProxyEnv = {
  Bindings: Env;
  Variables: { projectId: string; body: ProxyBody };
};
