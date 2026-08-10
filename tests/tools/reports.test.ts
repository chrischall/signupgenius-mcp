import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount } from './_setup.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { KeyModeRequiredError } from '../../src/client.js';

afterEach(() => vi.restoreAllMocks());

const cases: Array<[string, string]> = [
  ['signupgenius_report_all', '/signups/report/all/123'],
  ['signupgenius_report_filled', '/signups/report/filled/123'],
  ['signupgenius_report_available', '/signups/report/available/123'],
];

describe.each(cases)('key mode: %s', (toolName, path) => {
  it(`calls ${path}`, async () => {
    const { handlers, requestSpy } = setupTools(registerReportTools);
    await handlers.get(toolName)!({ signupId: 123 });
    expect(requestSpy).toHaveBeenCalledWith(path);
  });

  it('rejects when signupId is missing', async () => {
    const { handlers } = setupTools(registerReportTools);
    await expect(handlers.get(toolName)!({})).rejects.toThrow();
  });
});

describe.each(cases.map(([t]) => t))('session mode rejection: %s', (toolName) => {
  it('names the tool, the mode required and the mode in effect', async () => {
    const { handlers } = setupTools(registerReportTools, sessionAccount);
    const invoke = () => handlers.get(toolName)!({ signupId: 1 });
    await expect(invoke()).rejects.toBeInstanceOf(KeyModeRequiredError);
    await expect(invoke()).rejects.toThrow(
      new RegExp(`${toolName} requires Pro key mode but the server is running in session mode`),
    );
  });

  it('says a Pro key is needed and points at the tool that actually works', async () => {
    // "Switch to key mode" alone sent users looking for a setting. Key mode
    // means a paid API key, and reports are owner-scoped either way — so the
    // message has to name signupgenius_list_slots.
    const { handlers } = setupTools(registerReportTools, sessionAccount);
    const err = await handlers
      .get(toolName)!({ signupId: 1 })
      .catch((e: Error) => e);
    expect(err.message).toContain('SIGNUPGENIUS_USER_KEY');
    expect(err.message).toContain('owner-scoped');
    expect(err.message).toContain('signupgenius_list_slots');
  });
});
