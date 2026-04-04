import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import { getCorsHeaders } from "../_shared/cors.ts";

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// Rate limiting per user
const rateLimiter = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 5;
const RATE_WINDOW_MS = 60 * 1000;

function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // ─── Auth check (CRITICAL FIX) ───
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Non authentifié' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'Non authentifié' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Rate limit
    if (!checkRateLimit(user.id)) {
      return new Response(JSON.stringify({ error: 'Trop de requêtes' }), {
        status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { action, imageUrl } = await req.json();
    // SECURITY: userId is ALWAYS derived from JWT, never from client
    const userId = user.id;

    if (action === 'analyze_photo') {
      if (!imageUrl || typeof imageUrl !== 'string') {
        return new Response(JSON.stringify({ error: 'imageUrl requis' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const analysisPrompt = `Analyze this profile photo for signs of a fake or stolen profile picture. Check for:
1. Is this likely a stock photo? (watermarks, professional lighting, generic poses)
2. Does it look like a celebrity or public figure whose photo might be stolen?
3. Are there signs of AI generation? (artifacts, inconsistent lighting, weird hands/ears)
4. Does it look like a screenshot from social media? (UI elements, filters)
5. Is there text overlay suggesting it was taken from another platform?

Respond in JSON format:
{
  "risk_score": 0-100 (0=genuine, 100=definitely fake/stolen),
  "is_suspicious": boolean,
  "reasons": ["reason1", "reason2"],
  "recommendation": "approve" | "flag" | "reject",
  "details": "Brief explanation in French"
}`;

      const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash-lite',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: analysisPrompt },
                { type: 'image_url', image_url: { url: imageUrl } },
              ],
            },
          ],
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`);
      }

      const aiData = await response.json();
      const content = aiData.choices?.[0]?.message?.content || '{}';
      
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { risk_score: 0, is_suspicious: false, reasons: [], recommendation: 'approve', details: 'Analyse impossible' };

      return new Response(JSON.stringify({ success: true, analysis }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'compare_photos') {
      const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

      // Get recent profiles with avatars (exclude the authenticated user)
      const { data: profiles } = await serviceClient
        .from('profiles')
        .select('user_id,name,avatar_url')
        .not('avatar_url', 'is', null)
        .neq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!profiles?.length) {
        return new Response(JSON.stringify({ success: true, duplicates: [], message: 'Pas assez de profils pour comparer' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Get the authenticated user's avatar
      const { data: myProfile } = await serviceClient
        .from('profiles')
        .select('avatar_url')
        .eq('user_id', userId)
        .single();

      if (!myProfile?.avatar_url) {
        return new Response(JSON.stringify({ success: true, has_duplicates: false, matches: [], summary: 'Pas de photo de profil' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      const otherAvatars = profiles.slice(0, 10).map((p: any) => p.avatar_url).filter(Boolean);
      
      const comparePrompt = `I will show you multiple profile photos. The FIRST image is the target photo we're investigating. The remaining images are from other users on the platform.

Your task: Check if the target photo (first image) appears to be the SAME PERSON or the SAME EXACT PHOTO as any of the other images.

Respond in JSON format:
{
  "has_duplicates": boolean,
  "matches": [
    {
      "image_index": number (1-based index of the matching other image),
      "confidence": 0-100,
      "match_type": "same_photo" | "same_person" | "similar"
    }
  ],
  "summary": "Brief explanation in French"
}`;

      const contentPayload = [
        { type: 'text', text: comparePrompt },
        { type: 'image_url', image_url: { url: myProfile.avatar_url } },
        ...otherAvatars.map((url: string) => ({ type: 'image_url', image_url: { url } })),
      ];

      const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash-lite',
          messages: [{ role: 'user', content: contentPayload }],
          temperature: 0.1,
        }),
      });

      if (!response.ok) throw new Error(`AI API error: ${response.status}`);

      const aiData = await response.json();
      const aiContent = aiData.choices?.[0]?.message?.content || '{}';
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { has_duplicates: false, matches: [], summary: 'Analyse impossible' };

      const enrichedMatches = (result.matches || []).map((m: any) => ({
        ...m,
        matched_user: profiles[m.image_index - 1] || null,
      }));

      return new Response(JSON.stringify({ success: true, ...result, matches: enrichedMatches }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Action inconnue' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
