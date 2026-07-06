import { describe, it, expect, afterEach, vi } from 'vitest';
import { setupTools, sessionAccount } from './_setup.js';
import { registerReportTools } from '../../src/tools/reports.js';
import { ModeMismatchError } from '../../src/client.js';

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
  it('throws ModeMismatchError hinting the user to switch to key mode', async () => {
    const { handlers } = setupTools(registerReportTools, sessionAccount);
    const invoke = () => handlers.get(toolName)!({ signupId: 1 });
    await expect(invoke()).rejects.toBeInstanceOf(ModeMismatchError);
    await expect(invoke()).rejects.toMatchObject({
      hint: `Switch to key mode to use ${toolName}.`,
    });
  });
});
