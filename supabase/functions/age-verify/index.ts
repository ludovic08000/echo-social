import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ddosShield } from "../_shared/ddos-shield.ts";

/**
 * age-verify: Uses AI vision to estimate age from an uploaded photo.
 * If user declared 18+ but looks under 18, flags the account and
 * activates parental controls + requests ID verification.
 *
 * POST body: { imageUrl: string }
 */

import { getCorsHeaders } from "../_shared/cors.ts";

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // DDoS protection — critical tier for identity verification
  const ddosBlock = await ddosShield(req, corsHeaders, "critical", "age-verify");
  if (ddosBlock) return ddosBlock;

  try {
    // Auth
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

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Check if already verified — skip
    const { data: profile } = await serviceClient
      .from('profiles')
      .select('age_verified, age_verification_status, date_of_birth')
      .eq('user_id', user.id)
      .single();

    if (profile?.age_verified || profile?.age_verification_status === 'pending') {
      return new Response(JSON.stringify({ status: 'already_checked', flagged: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { imageUrl } = await req.json();
    if (!imageUrl) {
      return new Response(JSON.stringify({ error: 'imageUrl requis' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Calculate declared age
    let declaredAge = 99;
    if (profile?.date_of_birth) {
      const dob = new Date(profile.date_of_birth);
      const today = new Date();
      declaredAge = today.getFullYear() - dob.getFullYear();
      const m = today.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) declaredAge--;
    }

    // Only check users who declared 16+ (minors already have protections)
    if (declaredAge < 16) {
      await serviceClient.from('profiles').update({ age_verified: true, age_verification_status: 'verified' }).eq('user_id', user.id);
      return new Response(JSON.stringify({ status: 'minor_declared', flagged: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Call Gemini vision to estimate age
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Analyze this photo and estimate the age of the person visible. 
Reply ONLY with a JSON object: {"estimated_age": <number>, "confidence": "low"|"medium"|"high", "face_detected": true|false}
If no face is detected, return {"estimated_age": 0, "confidence": "low", "face_detected": false}.
Do not add any other text.`,
              },
              {
                type: 'image_url',
                image_url: { url: imageUrl },
              },
            ],
          },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'report_age_estimate',
              description: 'Report the estimated age from the photo',
              parameters: {
                type: 'object',
                properties: {
                  estimated_age: { type: 'number', description: 'Estimated age in years' },
                  confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                  face_detected: { type: 'boolean' },
                },
                required: ['estimated_age', 'confidence', 'face_detected'],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'report_age_estimate' } },
      }),
    });

    if (!aiResponse.ok) {
      console.error('AI gateway error:', aiResponse.status);
      // Don't block the user if AI fails — mark as verified
      await serviceClient.from('profiles').update({ age_verified: true, age_verification_status: 'verified' }).eq('user_id', user.id);
      return new Response(JSON.stringify({ status: 'ai_error', flagged: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse.json();
    
    // Extract from tool call
    let estimatedAge = 0;
    let confidence = 'low';
    let faceDetected = false;

    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        estimatedAge = args.estimated_age || 0;
        confidence = args.confidence || 'low';
        faceDetected = args.face_detected ?? false;
      } catch {
        // Try parsing from content as fallback
        const content = aiData.choices?.[0]?.message?.content || '';
        try {
          const parsed = JSON.parse(content);
          estimatedAge = parsed.estimated_age || 0;
          confidence = parsed.confidence || 'low';
          faceDetected = parsed.face_detected ?? false;
        } catch {
          console.warn('Could not parse AI response');
        }
      }
    }

    console.log(`Age verify: user=${user.id}, declared=${declaredAge}, estimated=${estimatedAge}, confidence=${confidence}, face=${faceDetected}`);

    // If no face detected, skip — don't flag
    if (!faceDetected) {
      await serviceClient.from('profiles').update({ age_verified: true, age_verification_status: 'verified' }).eq('user_id', user.id);
      return new Response(JSON.stringify({ status: 'no_face', flagged: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // FLAG: User declared 16+ but AI estimates under 18 with medium+ confidence
    const isSuspicious = declaredAge >= 16 && estimatedAge > 0 && estimatedAge < 18 && (confidence === 'medium' || confidence === 'high');

    if (isSuspicious) {
      // 1. Flag profile
      await serviceClient.from('profiles').update({
        age_verification_status: 'flagged',
      }).eq('user_id', user.id);

      // 2. Activate parental controls
      await serviceClient.from('parental_controls').upsert({
        user_id: user.id,
        is_active: true,
        is_minor: true,
        allowed_categories: ['education', 'sport', 'gaming', 'musique', 'art', 'humour'],
      }, { onConflict: 'user_id' });

      // 3. Create identity verification request (72h deadline)
      const deadline = new Date();
      deadline.setHours(deadline.getHours() + 72);

      await serviceClient.from('identity_verifications').insert({
        reported_user_id: user.id,
        reporter_id: user.id, // Self-triggered by system
        reason: `Vérification d'âge automatique : l'IA estime ${estimatedAge} ans (confiance: ${confidence}) alors que l'utilisateur a déclaré ${declaredAge} ans.`,
        status: 'pending',
        deadline_at: deadline.toISOString(),
      });

      return new Response(JSON.stringify({
        status: 'flagged',
        flagged: true,
        estimated_age: estimatedAge,
        message: 'Vérification d\'identité requise. Veuillez fournir une pièce d\'identité.',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // All good — mark as verified
    await serviceClient.from('profiles').update({
      age_verified: true,
      age_verification_status: 'verified',
    }).eq('user_id', user.id);

    return new Response(JSON.stringify({ status: 'verified', flagged: false }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('age-verify error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erreur interne' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
