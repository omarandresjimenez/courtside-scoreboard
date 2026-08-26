import { ADMIN_EVENTS, SERVER_EVENTS, TV_EVENTS, UMPIRE_EVENTS } from './events.js';

describe('event name contracts', () => {
  it('namespaces every umpire event under "umpire:"', () => {
    Object.values(UMPIRE_EVENTS).forEach((name) => expect(name).toMatch(/^umpire:/));
  });

  it('namespaces every admin event under "admin:"', () => {
    Object.values(ADMIN_EVENTS).forEach((name) => expect(name).toMatch(/^admin:/));
  });

  it('namespaces every TV event under "tv:"', () => {
    Object.values(TV_EVENTS).forEach((name) => expect(name).toMatch(/^tv:/));
  });

  it('namespaces every server event under "server:"', () => {
    Object.values(SERVER_EVENTS).forEach((name) => expect(name).toMatch(/^server:/));
  });

  it('keeps event names unique across all four namespaces', () => {
    const allNames = [
      ...Object.values(UMPIRE_EVENTS),
      ...Object.values(ADMIN_EVENTS),
      ...Object.values(TV_EVENTS),
      ...Object.values(SERVER_EVENTS),
    ];
    expect(new Set(allNames).size).toBe(allNames.length);
  });
});
