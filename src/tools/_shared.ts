import { textResult } from '@chrischall/mcp-utils';

/**
 * Wrap a value as an MCP text content block — the standard tool return shape.
 *
 * Re-exported from `@chrischall/mcp-utils` (`textResult`) so every sibling MCP
 * shares one implementation; the local `textContent` alias keeps the call
 * sites in `tools/*.ts` unchanged.
 */
export const textContent = textResult;
