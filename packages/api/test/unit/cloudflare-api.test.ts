import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addQueueConsumer,
  getDispatchWorkerProxyToken,
} from '../../src/provisioning/cloudflare-api.ts';

const ACCOUNT = 'acc_test';
const TOKEN = 'token_test';
const QUEUE_ID = 'queue-uuid';
const SCRIPT = 'void-dispatch';

function cfSuccess(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function cfError(message: string): Response {
  return Response.json({ success: false, errors: [{ code: 100, message }] }, { status: 400 });
}

describe('addQueueConsumer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {status:"created"} when the POST creates a new consumer', async () => {
    fetchMock.mockResolvedValueOnce(cfSuccess({ consumer_id: 'c1' }));

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT);

    expect(result).toEqual({ status: 'created' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('returns {status:"updated"} when the consumer already exists under our script', async () => {
    // POST fails with "already has a consumer"
    fetchMock.mockResolvedValueOnce(cfError('queue already has a consumer'));
    // GET lists our consumer
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ consumer_id: 'c1', script: SCRIPT, settings: {} }]),
    );
    // PUT to update settings
    fetchMock.mockResolvedValueOnce(cfSuccess({ consumer_id: 'c1' }));

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT, { batch_size: 1 });

    expect(result).toEqual({ status: 'updated' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2][1] as RequestInit).method).toBe('PUT');
  });

  it('returns {status:"conflict", ownerScript} when a different script owns the consumer', async () => {
    fetchMock.mockResolvedValueOnce(cfError('queue already has a consumer'));
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ consumer_id: 'c1', script: 'other-script', settings: {} }]),
    );

    const result = await addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT, { batch_size: 1 });

    expect(result).toEqual({ status: 'conflict', ownerScript: 'other-script' });
    // POST + GET, but no PUT on the conflicting consumer
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws when POST fails for a reason other than "already exists"', async () => {
    fetchMock.mockResolvedValueOnce(cfError('insufficient permissions'));

    await expect(addQueueConsumer(ACCOUNT, TOKEN, QUEUE_ID, SCRIPT)).rejects.toThrow(
      /insufficient permissions/i,
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('getDispatchWorkerProxyToken', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns {kind:"found", token} for the __VOID_PROXY_TOKEN binding baked into the worker', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([
        { type: 'plain_text', name: '__PROJECT_ID', text: 'proj_a' },
        { type: 'plain_text', name: '__VOID_PROXY_TOKEN', text: 'baked-token-value' },
        { type: 'queue', name: 'QUEUE_EMAILS', queue_name: 'proj_a-emails' },
      ]),
    );

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-a-dpl_1');

    expect(result).toEqual({ kind: 'found', token: 'baked-token-value' });
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toMatch(
      /\/workers\/dispatch\/namespaces\/void-users\/scripts\/user-a-dpl_1\/bindings$/,
    );
  });

  it('returns {kind:"missing"} when bindings list has no __VOID_PROXY_TOKEN', async () => {
    fetchMock.mockResolvedValueOnce(
      cfSuccess([{ type: 'plain_text', name: '__PROJECT_ID', text: 'proj_a' }]),
    );

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-a-dpl_1');

    expect(result).toEqual({ kind: 'missing' });
  });

  it('returns {kind:"error"} with the underlying Error on CF API failure (rate limit / auth / network)', async () => {
    fetchMock.mockResolvedValueOnce(cfError('rate limited'));

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-missing');

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toMatch(/rate limited/i);
    }
  });

  it('returns {kind:"error"} when fetch itself throws (network failure)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));

    const result = await getDispatchWorkerProxyToken(ACCOUNT, TOKEN, 'void-users', 'user-net-fail');

    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.error.message).toMatch(/ECONNRESET/);
    }
  });
});
