import { copyToClipboard } from './clipboard.js';

// jsdom doesn't implement document.execCommand at all, so each test that
// needs it stubs the property directly and deletes it afterwards — there's
// no real implementation to restore the way jest.spyOn would.
function stubExecCommand(impl: () => boolean) {
  document.execCommand = jest.fn(impl) as unknown as typeof document.execCommand;
}

function unstubExecCommand() {
  // @ts-expect-error -- undoing stubExecCommand; jsdom never had this method.
  delete document.execCommand;
}

describe('copyToClipboard', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
  });

  it('uses navigator.clipboard when available (secure context)', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('falls back to execCommand when navigator.clipboard.writeText rejects', async () => {
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    stubExecCommand(() => true);

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');

    unstubExecCommand();
  });

  it('falls back to execCommand when navigator.clipboard is unavailable (insecure LAN http://)', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    stubExecCommand(() => true);

    await expect(copyToClipboard('hello')).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');

    unstubExecCommand();
  });

  it('reports failure when execCommand cannot copy', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    stubExecCommand(() => false);

    await expect(copyToClipboard('hello')).resolves.toBe(false);

    unstubExecCommand();
  });

  it('reports failure when execCommand throws', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    stubExecCommand(() => {
      throw new Error('not allowed');
    });

    await expect(copyToClipboard('hello')).resolves.toBe(false);

    unstubExecCommand();
  });
});
