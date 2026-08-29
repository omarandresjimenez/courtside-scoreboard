import { generateEventId } from './id.js';

describe('generateEventId', () => {
  it('uses crypto.randomUUID when the browser exposes it (secure context)', () => {
    const spy = jest
      .spyOn(crypto, 'randomUUID')
      .mockReturnValue('11111111-1111-4111-8111-111111111111');

    expect(generateEventId()).toBe('11111111-1111-4111-8111-111111111111');

    spy.mockRestore();
  });

  it('falls back to crypto.getRandomValues when randomUUID is unavailable (insecure LAN http://)', () => {
    const originalRandomUUID = crypto.randomUUID;
    // jsdom doesn't implement getRandomValues at all, so there's nothing to
    // restore afterwards beyond deleting this test's stub.
    // @ts-expect-error -- simulating an insecure context, where browsers omit randomUUID entirely.
    delete crypto.randomUUID;
    crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
      if (array instanceof Uint8Array) {
        for (let i = 0; i < array.length; i += 1) array[i] = i * 7;
      }
      return array;
    }) as Crypto['getRandomValues'];

    const id = generateEventId();

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    crypto.randomUUID = originalRandomUUID;
    // @ts-expect-error -- undoing the stub above; jsdom never had this method to begin with.
    delete crypto.getRandomValues;
  });
});
