# ForSure ML Architecture

`src/lib/ml` is the client-side administration folder for feed, live, video, and AI ranking helpers.

Keep the split strict:

- `src/lib/ml/*`: pure client contracts, mappers, local preference cache, diversity/session helpers, AI module registry.
- `src/hooks/useML*.ts` and feed hooks: React integration, telemetry dispatch, user-session wiring.
- `supabase/functions/*`: server execution for scoring, training, moderation, matching, and optimization.
- `supabase/migrations/*`: schema, RPCs, vector indexes, A/B telemetry, and offline training observability.

The ranking source of truth should stay server-side. Client helpers must not replace server scoring with gameable local ranking, except for small UI-only adjustments such as session diversity and cache hydration.

## Current Server Stack

Important Edge Functions are listed in `catalog.ts`:

- `ml-feed`, `ml-feed-train`, `ml-twotower-train`
- `feed-scoring`, `feed-optimizer`
- `ml-matching`, `ml-moderation`, `ml-fraud-detect`
- `ai-engine`, `ai-content`

Important RPCs are also listed in `catalog.ts`:

- `get_feed_posts_v8`
- `ml_retrieve_feed_candidates_v8`
- `ml_record_feed_ab_events`
- `feed_score_batch`, `video_score_batch`, `live_score_batch`, `live_feed_bundle`

## Operating Rules

- Retrieval should use server-side candidates first: embeddings, creator features, user profile, recency, social graph.
- Rerank should balance predicted engagement, diversity, creator novelty, safety, repetition penalty, and exploration.
- Telemetry should be batched and bounded before sending to Supabase.
- Offline training must be observable through `ml_training_runs` and `ml_offline_training_health`.
- Do not move Supabase Edge Function folders into this directory; Supabase expects their current paths.
