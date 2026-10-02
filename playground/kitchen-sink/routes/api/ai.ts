import { defineHandler } from 'void';
import { ai } from 'void/ai';

function textInputForModel(model: string, prompt: string) {
  if (model.startsWith('google/')) {
    return {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: 512,
      },
    };
  }

  return {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 512,
  };
}

export const POST = defineHandler(async (c) => {
  const { prompt, model } = await c.req.json<{
    prompt: string;
    model: string;
  }>();

  try {
    const inputs = textInputForModel(model, prompt);
    if (model.startsWith('google/')) {
      return ai.run(model, inputs).match({
        ok: (result) => c.json(result),
        limited: (limit) =>
          limit.response({
            message: 'AI is temporarily unavailable. Your prompt has been kept.',
          }),
      });
    }

    return ai
      .stream(model, inputs)
      .match({ ok: (response) => response, limited: (limit) => limit.response() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
