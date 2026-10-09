# Roadmap

- [x] Vérifier limites de durée live Instagram/TikTok
- [x] Limite live 1 h : jeton 75 min + rejet >60 min (livekit-token déployée), alerte 5 min + arrêt auto (HostLiveView), cron horaire end-stale-lives (jobid 264), tests 2/2
- [x] Badge Créateur 4,99 €/mois + 25 % sur pourboires et Market
- [x] Abonnements des fans aux créateurs (25 % ForSure) : migration 0026, fan-club-manage + create-fan-subscription + stripe-webhook + marketplace-checkout déployés, panneau Club, posts réservés aux abonnés, tests 5/5
- [ ] Fil classé : appliquer la règle « réservé aux abonnés » dans feed_eligible_post_ids_internal + remonter subscriber_only au client
- [ ] Publier le frontend (cartes média style publication, filtre bien-être, limite live 1 h, club d'abonnés) — en attente de feu vert utilisateur
- [ ] Live à vie : 2,99 €/live, inclus avec le badge — à construire
