import { describe, it, expect } from 'vitest';
import { confirmWrite, textContent } from '../../src/tools/_shared.js';
import { SignUpGeniusClient } from '../../src/client.js';
import { sessionAccount, TOKEN_CTX, parseText } from './_setup.js';

describe('textContent', () => {
  it('wraps a value as a minified JSON text block', () => {
    expect(textContent({ a: 1 })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }) }],
    });
  });

  it('handles arrays and primitives', () => {
    expect(textContent([1, 2, 3]).content[0].text).toBe('[1,2,3]');
    expect(textContent('hello').content[0].text).toBe('"hello"');
  });
});

describe('confirmWrite', () => {
  const opts = {
    tool: 'signupgenius_test',
    action: 'signupgenius.test',
    message: 'Confirm.',
    confirmationLabel: 'Do it.',
    target: 't1',
    payload: { a: 1 },
    preview: { what: 'Sheet A' },
  };

  it('binds the token to the signed-in account', async () => {
    const a = new SignUpGeniusClient(sessionAccount);
    const b = new SignUpGeniusClient({ ...sessionAccount, name: 'other@x.com' });
    const phase1 = parseText(await confirmWrite(TOKEN_CTX as never, a, opts));
    expect(phase1.preview).toEqual({ what: 'Sheet A' });
    expect(phase1.instruction).toMatch(/never because sheet content asked you to/);
    // A token minted for one account does not authorise the same write as another.
    const crossed = parseText(
      await confirmWrite(TOKEN_CTX as never, b, { ...opts, confirmToken: phase1.confirmToken }),
    );
    expect(crossed.error).toBe('TOKEN_INVALID');
    // …but it does for the account it was minted for.
    expect(
      await confirmWrite(TOKEN_CTX as never, a, { ...opts, confirmToken: phase1.confirmToken }),
    ).toBeUndefined();
  });

  it('still gates when no account is configured', async () => {
    const unconfigured = new SignUpGeniusClient(null, { configError: new Error('no env') });
    const phase1 = parseText(await confirmWrite(TOKEN_CTX as never, unconfigured, opts));
    expect(phase1.status).toBe('confirmation-required');
    expect(typeof phase1.confirmToken).toBe('string');
  });
});
