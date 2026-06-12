// Supabase Edge Function: openai-chat-completion
// Purpose: keep OPENAI_API_KEY in Supabase Secrets, not in the local Next/Electron app.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return Response.json(
      { error: 'Method not allowed. Use POST.' },
      { status: 405, headers: corsHeaders },
    );
  }

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) {
    return Response.json(
      { error: 'Missing OPENAI_API_KEY in Supabase Edge Function Secrets.' },
      { status: 500, headers: corsHeaders },
    );
  }

  try {
    const body = await req.json();

    // Keep this proxy generic: the Next app can send the same payload it previously sent to OpenAI.
    const openAiPayload = {
      model: body.model ?? 'gpt-4o-mini',
      messages: body.messages,
      temperature: body.temperature ?? 0,
      max_tokens: body.max_tokens ?? body.max_completion_tokens,
      response_format: body.response_format,
    };

    // Remove undefined fields so OpenAI does not reject the request.
    Object.keys(openAiPayload).forEach((key) => {
      if ((openAiPayload as Record<string, unknown>)[key] === undefined) {
        delete (openAiPayload as Record<string, unknown>)[key];
      }
    });

    if (!Array.isArray(openAiPayload.messages)) {
      return Response.json(
        { error: 'Missing or invalid messages array.' },
        { status: 400, headers: corsHeaders },
      );
    }

    const openAiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(openAiPayload),
    });

    const text = await openAiResponse.text();

    return new Response(text, {
      status: openAiResponse.status,
      headers: {
        ...corsHeaders,
        'Content-Type': openAiResponse.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500, headers: corsHeaders },
    );
  }
});
