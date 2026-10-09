# Roadmap

- [x] Vérifier limites de durée live Instagram/TikTok
- [x] Limite live 1 h : jeton 75 min + rejet >60 min (livekit-token déployée), alerte 5 min + arrêt auto (HostLiveView), cron horaire end-stale-lives (jobid 264), tests 2/2
- [x] Badge Créateur 4,99 €/mois + 25 % sur pourboires et Market
- [x] Abonnements des fans aux créateurs (25 % ForSure) : migration 0026, fan-club-manage + create-fan-subscription + stripe-webhook + marketplace-checkout déployés, panneau Club, posts réservés aux abonnés, tests 5/5
- [x] Fil classé : règle « réservé aux abonnés » appliquée dans feed_eligible_post_ids_internal (migration 0027) + subscriber_only remonté au client (recsysV8, PostCard) ; vérifié fil invité vs fil auteur, tests 6/6
- [ ] Publier le frontend (cartes média style publication, filtre bien-être, limite live 1 h, club d'abonnés) — en attente de feu vert utilisateur
- [ ] Live à vie : 2,99 €/live en paiement unique (même pour un créateur badgé) — à construire
