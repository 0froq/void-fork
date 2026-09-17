import { beforeEach, expect, it, vi } from 'vite-plus/test';
import { createSpinner } from '../../src/cli/output.ts';

const mocks = vi.hoisted(() => ({
  ci: vi.fn(),
  spinner: vi.fn(),
  log: { step: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@clack/prompts', () => ({ isCI: mocks.ci, spinner: mocks.spinner, log: mocks.log }));
beforeEach(() => {
  vi.clearAllMocks();
});

it('passes interactive cancellation through to the native spinner', () => {
  mocks.ci.mockReturnValue(false);
  const native = { start: vi.fn() };
  mocks.spinner.mockReturnValue(native);
  const onCancel = vi.fn();
  expect(createSpinner({ onCancel })).toBe(native);
  expect(mocks.spinner).toHaveBeenCalledWith({ onCancel });
});

it('uses plain progress messages in CI without starting an animated spinner', () => {
  mocks.ci.mockReturnValue(true);
  const progress = createSpinner();
  progress.start('Installing the platform');
  progress.message('Preparing the platform database');
  progress.stop('Platform installed.');
  expect(mocks.spinner).not.toHaveBeenCalled();
  expect(mocks.log.step.mock.calls).toEqual([
    ['Installing the platform'],
    ['Preparing the platform database'],
  ]);
  expect(mocks.log.info).toHaveBeenCalledWith('Platform installed.');
});
