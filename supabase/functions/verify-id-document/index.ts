import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * verify-id-document: Analyses an uploaded ID document (carte d'identité, passeport)
 * using AI vision to detect:
 * 1. AI-generated / fake documents
 * 2. Manipulated / photoshopped documents
 * 3. Photos of screens showing documents
 * 4. Invalid or unreadable documents
 *
 * POST body: { imageUrl: string }
 * Returns: { valid: boolean, reason?: string, confidence: string, details: object }
 */

import { getCorsHeaders } from "../_shared/cors.ts";

const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

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

    const { imageUrl } = await req.json();
    if (!imageUrl) {
      return new Response(JSON.stringify({ error: 'imageUrl requis' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Use Gemini vision to deeply analyze the document
    const aiResponse = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-pro',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Tu es un expert en détection de fraude documentaire et en analyse forensique d'images numériques.

Analyse cette image qui est censée être une pièce d'identité officielle (carte d'identité ou passeport).

Tu dois vérifier TOUTES ces caractéristiques avec la plus grande rigueur :

## 1. DÉTECTION IA / GÉNÉRATION ARTIFICIELLE
- Cherche des artefacts typiques de l'IA générative : textures trop lisses, reflets incohérents, micro-patterns répétitifs
- Vérifie la cohérence des polices de caractères (les IA mélangent souvent les styles)
- Analyse les bords du document : trop nets ou trop flous par rapport au fond
- Vérifie les détails de sécurité : hologrammes, filigranes, micro-impressions (souvent absents ou mal reproduits par l'IA)
- Détecte les anomalies dans les textes : caractères déformés, mots inventés, numéros au format incorrect

## 2. MANIPULATION / PHOTOSHOP
- Cherche des incohérences d'éclairage ou d'ombres
- Analyse les niveaux de compression JPEG dans différentes zones
- Vérifie si la photo d'identité semble collée ou superposée
- Cherche des traces de clonage ou de tampon

## 3. PHOTO D'ÉCRAN
- Détecte si c'est une photo d'un écran montrant le document (moiré, pixels visibles, reflets d'écran)

## 4. VALIDITÉ DU DOCUMENT
- Le document ressemble-t-il à un vrai format officiel connu (CNI française, passeport, etc.) ?
- Les zones MRZ (Machine Readable Zone) sont-elles présentes et cohérentes ?
- Le format des numéros est-il correct ?

Réponds UNIQUEMENT avec un appel à la fonction report_document_analysis.`,
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
              name: 'report_document_analysis',
              description: 'Report the forensic analysis of the identity document',
              parameters: {
                type: 'object',
                properties: {
                  is_authentic: {
                    type: 'boolean',
                    description: 'true if the document appears to be a genuine, unaltered official identity document',
                  },
                  is_ai_generated: {
                    type: 'boolean',
                    description: 'true if the document shows signs of being AI-generated (GAN, diffusion model, etc.)',
                  },
                  is_manipulated: {
                    type: 'boolean',
                    description: 'true if the document shows signs of photo manipulation (Photoshop, etc.)',
                  },
                  is_screen_photo: {
                    type: 'boolean',
                    description: 'true if this is a photo of a screen displaying the document',
                  },
                  is_valid_format: {
                    type: 'boolean',
                    description: 'true if the document matches a known official ID format',
                  },
                  document_type: {
                    type: 'string',
                    enum: ['carte_identite', 'passeport', 'permis_conduire', 'autre', 'inconnu'],
                  },
                  confidence: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                  },
                  ai_generation_indicators: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of specific indicators suggesting AI generation',
                  },
                  manipulation_indicators: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'List of specific indicators suggesting manipulation',
                  },
                  rejection_reason: {
                    type: 'string',
                    description: 'Human-readable reason for rejection in French, or empty if accepted',
                  },
                },
                required: ['is_authentic', 'is_ai_generated', 'is_manipulated', 'is_screen_photo', 'is_valid_format', 'document_type', 'confidence', 'ai_generation_indicators', 'manipulation_indicators', 'rejection_reason'],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: 'function', function: { name: 'report_document_analysis' } },
      }),
    });

    if (!aiResponse.ok) {
      console.error('AI gateway error:', aiResponse.status);
      // On error, don't reject — let manual review handle it
      return new Response(JSON.stringify({ valid: true, reason: 'ai_unavailable', confidence: 'low', details: {} }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const aiData = await aiResponse.json();

    // Parse tool call response
    let analysis = {
      is_authentic: false,
      is_ai_generated: false,
      is_manipulated: false,
      is_screen_photo: false,
      is_valid_format: false,
      document_type: 'inconnu',
      confidence: 'low',
      ai_generation_indicators: [] as string[],
      manipulation_indicators: [] as string[],
      rejection_reason: '',
    };

    const toolCall = aiData.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      try {
        analysis = { ...analysis, ...JSON.parse(toolCall.function.arguments) };
      } catch {
        console.warn('Could not parse AI tool response');
      }
    }

    console.log(`[verify-id-document] user=${user.id}, authentic=${analysis.is_authentic}, ai_gen=${analysis.is_ai_generated}, manipulated=${analysis.is_manipulated}, screen=${analysis.is_screen_photo}, format=${analysis.is_valid_format}, type=${analysis.document_type}, confidence=${analysis.confidence}`);

    const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Determine if document should be rejected
    const isRejected = analysis.is_ai_generated || analysis.is_manipulated || analysis.is_screen_photo || !analysis.is_valid_format;

    if (isRejected && analysis.confidence !== 'low') {
      // Log the fraud attempt
      await serviceClient.from('identity_verifications').update({
        admin_note: `🚨 DOCUMENT REJETÉ PAR IA:\n` +
          `Type: ${analysis.document_type}\n` +
          `IA générée: ${analysis.is_ai_generated ? '⚠️ OUI' : 'Non'}\n` +
          `Manipulé: ${analysis.is_manipulated ? '⚠️ OUI' : 'Non'}\n` +
          `Photo d'écran: ${analysis.is_screen_photo ? '⚠️ OUI' : 'Non'}\n` +
          `Format valide: ${analysis.is_valid_format ? 'Oui' : '⚠️ NON'}\n` +
          `Confiance: ${analysis.confidence}\n` +
          `Indicateurs IA: ${analysis.ai_generation_indicators.join(', ') || 'aucun'}\n` +
          `Indicateurs manip: ${analysis.manipulation_indicators.join(', ') || 'aucun'}\n` +
          `Raison: ${analysis.rejection_reason}`,
        status: 'rejected',
      }).eq('reported_user_id', user.id).eq('status', 'pending');

      // If AI-generated with high confidence → flag as fraud attempt, potential ban
      if (analysis.is_ai_generated && analysis.confidence === 'high') {
        await serviceClient.from('abuse_reports').insert({
          reported_user_id: user.id,
          reporter_id: user.id,
          report_type: 'fraud',
          description: `Tentative de fraude documentaire : document d'identité généré par IA détecté. Indicateurs: ${analysis.ai_generation_indicators.join(', ')}`,
          status: 'pending',
        });
      }

      return new Response(JSON.stringify({
        valid: false,
        reason: analysis.rejection_reason || 'Document suspect détecté',
        confidence: analysis.confidence,
        details: {
          is_ai_generated: analysis.is_ai_generated,
          is_manipulated: analysis.is_manipulated,
          is_screen_photo: analysis.is_screen_photo,
          is_valid_format: analysis.is_valid_format,
          document_type: analysis.document_type,
          indicators: [...analysis.ai_generation_indicators, ...analysis.manipulation_indicators],
        },
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Document accepted — update verification record
    await serviceClient.from('identity_verifications').update({
      admin_note: `✅ Document vérifié par IA:\nType: ${analysis.document_type}\nConfiance: ${analysis.confidence}\nAuthentique: ${analysis.is_authentic}`,
    }).eq('reported_user_id', user.id).eq('status', 'pending');

    return new Response(JSON.stringify({
      valid: true,
      confidence: analysis.confidence,
      details: {
        document_type: analysis.document_type,
        is_authentic: analysis.is_authentic,
      },
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (e) {
    console.error('verify-id-document error:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'Erreur interne' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
