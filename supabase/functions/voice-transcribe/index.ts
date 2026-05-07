/**
 * voice-transcribe — on-demand transcription of a voice message audio.
 *
 * Privacy:
 *   - Audio bytes are forwarded to Lovable AI Gateway (Gemini 2.5 Flash)
 *     in-memory only. We do NOT persist the audio anywhere server-side.
 *   - The transcript is returned to the caller; storage is the client's
 *     decision (in practice we render it under the player and never write
 *     back to the DB).
 */
import { corsHeaders } from '@supabase/supabase-js/cors';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MB cap — sane for chat voicenotes

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { audio_base64?: string; mime?: string; lang_hint?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!body.audio_base64 || typeof body.audio_base64 !== 'string') {
    return new Response(JSON.stringify({ error: 'missing_audio' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Conservative size guard before we ship to the AI gateway.
  const approxBytes = Math.floor((body.audio_base64.length * 3) / 4);
  if (approxBytes > MAX_AUDIO_BYTES) {
    return new Response(JSON.stringify({ error: 'audio_too_large' }), {
      status: 413,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const apiKey = Deno.env.get('LOVABLE_API_KEY');
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'missing_api_key' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const mime = body.mime || 'audio/webm';
  const langHint = body.lang_hint || 'auto';

  const aiResp = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-2.5-flash',
      messages: [
        {
          role: 'system',
          content:
            'Tu transcris fidèlement un message vocal. Renvoie uniquement le texte transcrit, sans commentaire, sans guillemets, sans préfixe.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Transcris ce message vocal (${langHint === 'auto' ? 'détecte la langue' : `langue : ${langHint}`}).`,
            },
            {
              type: 'input_audio',
              input_audio: { data: body.audio_base64, format: mime.replace('audio/', '') },
            },
          ],
        },
      ],
    }),
  });

  if (!aiResp.ok) {
    const txt = await aiResp.text().catch(() => '');
    return new Response(JSON.stringify({ error: 'ai_failed', status: aiResp.status, detail: txt.slice(0, 200) }), {
      status: 502,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const ai = await aiResp.json().catch(() => null);
  const transcript = ai?.choices?.[0]?.message?.content?.toString?.()?.trim() ?? '';

  return new Response(JSON.stringify({ transcript }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
});
