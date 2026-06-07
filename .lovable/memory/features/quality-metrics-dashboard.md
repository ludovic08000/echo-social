---
name: Quality Metrics Dashboard
description: Mesure qualité prod (videos/posts/lives) via quality_events table + RPC summary/timeline
type: feature
---
Table `quality_events` (surface video/post/live, event_type view/watch_time/completion/skip_fast/rewatch/share/save/return_session/ios_perf, value, is_ios).
RLS: INSERT public (anon+auth), SELECT admin OR author_id=auth.uid().
RPC: `quality_metrics_summary(p_surface, p_since, p_author_id)` + `quality_metrics_timeline(..., p_bucket)` — SECURITY DEFINER, auto-filtre author=auth.uid() pour non-admin.
Hook `useQualityTracker({surface, contentId, authorId, durationMs})` → onEnter/onLeave/onShare/onSave. Batch flush 2s/25 events + visibilitychange.
Wiring: VideoCard (driven by isActive), PostCard (IntersectionObserver), LiveWatch (isVisible+!isHost).
UI: `QualityMetricsSection` (admin /admin section 'quality' + créateurs /quality ou /creator/quality). KPIs vues/uniques/temps/complétion/skip/rewatch/share/save/retour/perf iOS + 4 mini-bars SVG.
Skip rapide = dwell < 1500ms après view. Completion = (watchedMs/durationMs)*100 plafonné à 100.
iOS detect via UA. ios_perf valeur = dwell, metadata.memory si dispo.
