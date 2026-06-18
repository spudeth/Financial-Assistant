const API_KEY = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
const API_URL = 'https://api.anthropic.com/v1/messages';

export async function sendMessageToClaude(userMessage: string): Promise<string> {
  if (!API_KEY) {
    throw new Error('EXPO_PUBLIC_ANTHROPIC_API_KEY is not set in .env');
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Claude API error: ${errorData.error?.message || 'Unknown error'}`);
  }

  const data = await response.json();
  return data.content[0].text;
}
