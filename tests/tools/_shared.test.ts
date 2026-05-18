import { describe, it, expect } from 'vitest';
import { textContent } from '../../src/tools/_shared.js';

describe('textContent', () => {
  it('wraps a value as a pretty-printed JSON text block', () => {
    expect(textContent({ a: 1 })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ a: 1 }, null, 2) }],
    });
  });

  it('handles arrays and primitives', () => {
    expect(textContent([1, 2, 3]).content[0].text).toBe('[\n  1,\n  2,\n  3\n]');
    expect(textContent('hello').content[0].text).toBe('"hello"');
  });
});
