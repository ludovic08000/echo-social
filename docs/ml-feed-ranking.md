# Feed ML Ranking Notes

This project does not try to clone Meta/TikTok private systems. It applies the public, production-proven principles that fit the current Supabase/React stack.

Primary public references:

- TikTok, "How TikTok recommends videos #ForYou": user interactions, video metadata, device/account settings, watch completion, negative feedback, diversity, anti-repeat and safety eligibility.
- TikTok, "Discover more of what you love on TikTok": search/follow/favorite/like/comment signals, "Not Interested", creator/sound hiding and discovery injections.
- Meta Transparency Center, Facebook/Instagram ranking explanations: ranking predicts valuable/relevant content using content features, user activity and personalization controls.
- Meta Engineering, "On the value of diversified recommendations": author/media-type diversity prevents short-term engagement loops from narrowing long-term preference discovery.
- Meta Engineering, sequence learning for recommendations: recent event sequences are more expressive than only aggregated sparse features.
- ByteDance Monolith paper: recommendation freshness matters; real-time feedback loops and expirable/frequency-aware embeddings improve short-video ranking.

Implemented locally:

- `ml_interactions` is the source of truth for post-feed learning.
- `ml-feed` now builds its user profile from `ml_interactions`, not the legacy `user_behavior_signals` table.
- `video_score_batch` v6 uses completion/watch quality, velocity, explicit interests, recent sequence affinity, sound affinity, repetition penalties, exploration and wellbeing dampening.
- `live_score_batch` v6 uses live momentum, follow affinity, explicit/recent interests, host repetition penalties, exploration and wellbeing dampening.
- `useVideoFeed` asks the server scorer even in lightweight iPhone/feed mode, then avoids extra local algorithm work when server ranking is available.
- `useLiveStreams` uses server ranking first and only falls back to local scoring if the RPC is not deployed.

Still future work:

- Dedicated video/live embeddings instead of only post embeddings.
- Near-real-time training job for hot user/video rows.
- UI actions for "Not interested", "hide creator" and "hide sound".
- Stable cursor pagination over a pre-ranked server feed cache.
