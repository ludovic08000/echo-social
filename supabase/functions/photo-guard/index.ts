import { corsHeaders } from '../_shared/cors.ts';

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, userId, imageUrl } = await req.json();

    if (action === 'analyze_photo') {
      // Use Gemini to analyze if a profile photo looks suspicious
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

      const response = await fetch('https://api.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
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
      
      // Parse JSON from response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      const analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : { risk_score: 0, is_suspicious: false, reasons: [], recommendation: 'approve', details: 'Analyse impossible' };

      return new Response(JSON.stringify({ success: true, analysis }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'compare_photos') {
      // Compare a user's photo against other users' photos to detect duplicates
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
      };

      // Get recent profiles with avatars (exclude the target user)
      const profilesRes = await fetch(
        `${SUPABASE_URL}/rest/v1/profiles?avatar_url=not.is.null&user_id=neq.${userId}&select=user_id,name,avatar_url&limit=50&order=created_at.desc`,
        { headers }
      );
      const profiles = await profilesRes.json();

      if (!profiles?.length) {
        return new Response(JSON.stringify({ success: true, duplicates: [], message: 'Pas assez de profils pour comparer' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Use AI to compare the target image with a batch of other profile photos
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

      const content = [
        { type: 'text', text: comparePrompt },
        { type: 'image_url', image_url: { url: imageUrl } },
        ...otherAvatars.map((url: string) => ({ type: 'image_url', image_url: { url } })),
      ];

      const response = await fetch('https://api.lovable.dev/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash',
          messages: [{ role: 'user', content }],
          temperature: 0.1,
        }),
      });

      if (!response.ok) throw new Error(`AI API error: ${response.status}`);

      const aiData = await response.json();
      const aiContent = aiData.choices?.[0]?.message?.content || '{}';
      const jsonMatch = aiContent.match(/\{[\s\S]*\}/);
      const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { has_duplicates: false, matches: [], summary: 'Analyse impossible' };

      // Map matches to actual user info
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
