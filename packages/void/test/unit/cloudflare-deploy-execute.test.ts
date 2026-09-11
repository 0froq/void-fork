import { describe, expect, it, vi } from 'vite-plus/test';
import { executeCloudflareDeploy } from '../../src/cli/cloudflare-deploy/execute.ts';

describe('executeCloudflareDeploy', () => {
  it('pins the verified artifact and disables Wrangler provisioning and autoconfig', async () => {
    const runWrangler = vi.fn().mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      signal: null,
      error: null,
    });

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => true }),
    ).resolves.toEqual({ ok: true });
    expect(runWrangler).toHaveBeenCalledWith(
      [
        'deploy',
        '--env=',
        '--experimental-provision=false',
        '--experimental-auto-create=false',
        '--autoconfig=false',
      ],
      { capture: false },
    );
  });

  it('never starts Wrangler when uploader integrity cannot be verified', async () => {
    const runWrangler = vi.fn();

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => false }),
    ).resolves.toEqual({ ok: false, reason: 'uploader-changed' });
    expect(runWrangler).not.toHaveBeenCalled();
  });

  it('fails when the Wrangler process does not exit cleanly', async () => {
    const runWrangler = vi.fn().mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      signal: 'SIGTERM',
      error: null,
    });

    await expect(
      executeCloudflareDeploy({ runWrangler, verifyUploader: () => true }),
    ).resolves.toEqual({ ok: false, reason: 'deploy-failed', status: 0 });
  });
});
