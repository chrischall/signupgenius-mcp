/** Wrap a value as an MCP text content block — the standard tool return shape. */
export function textContent(data: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
