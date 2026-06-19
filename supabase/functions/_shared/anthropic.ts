const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export const MODELS = {
  // cheap/fast — used only for the first-pass READ/WRITE/CONVERSATIONAL classification
  router: 'claude-haiku-4-5-20251001',
  // full quality — used for composing replies, filling intent objects, and the edit micro-agent
  main: 'claude-sonnet-4-6',
};

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> };

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown };

export async function callClaude(opts: {
  model: string;
  system: string;
  messages: AnthropicMessage[];
  tools?: ToolDef[];
  tool_choice?: { type: 'tool'; name: string } | { type: 'any' } | { type: 'auto' };
  max_tokens?: number;
}) {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured as a Supabase secret');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.max_tokens ?? 1024,
      system: opts.system,
      messages: opts.messages,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Claude API error (${response.status}): ${errBody}`);
  }

  return response.json();
}

export function firstText(content: Array<{ type: string; text?: string }>): string {
  const block = content.find((b) => b.type === 'text');
  return block?.text ?? '';
}

export function toolUseBlocks(content: Array<{ type: string; [k: string]: unknown }>) {
  return content.filter((b) => b.type === 'tool_use') as unknown as Array<{ id: string; name: string; input: Record<string, unknown> }>;
}
