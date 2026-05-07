## Audit global du système

Basé sur les sessions récentes (E2EE, queue, fanout, recovery) et les logs edge, voici les axes faibles identifiés et le plan priorisé.

---

### 🔴 P0 — Stabilité critique (à faire maintenant)

**1. IndexedDB resilience (cause des crashs `connection is closing`)**
- Ajouter un wrapper `withDB()` qui retry 1x après réouverture si la connexion est fermée
- Centraliser dans `src/lib/crypto/indexedDb.ts` — supprimer les `db.close()` implicites
- Garantir qu'aucun handler `onversionchange`/`onclose` ne ferme la DB pendant une transaction active

**2. Boucles de re-render résiduelles**
- Audit des `useEffect` dans : `useE2EE`, `useAccountKeySync`, `MessagesView`, `DecryptedMessageBody`
- Stabiliser les callbacks via `useRef` partout où ils sont passés en dep
- Ajouter un dev-only counter pour détecter > 50 renders/sec et logger le composant

**3. Edge: `check_rate_limit` RPC manquante (warnings sur toutes les functions)**
- Soit créer la RPC `check_rate_limit(identifier, max, window_sec)` en SQL
- Soit supprimer les appels morts et ne garder que le rate-limit IP en mémoire

---

### 🟠 P1 — Fiabilité messagerie

**4. Queue d'envoi**
- Persister la queue (IndexedDB) pour survivre au reload — actuellement RAM only → perte si crash avant `delivered`
- Backoff exponentiel borné (3s → 6s → 12s → 30s, max 5 tentatives) au lieu de retry infini
- Consolidation des erreurs utilisateur (un seul toast par session, pas un par retry)

**5. Décryptage / device copies**
- Cache LRU des plaintexts décryptés (évite re-décryptage à chaque scroll)
- Coalescing des requêtes `requestDeviceCopyRetry` (1 par conv toutes les 30s, pas par message)
- Métrique : taux de messages décryptés / total → exposer dans admin SOC

**6. Recovery silencieux**
- Centraliser : un seul orchestrateur (`recoveryOrchestrator`) au lieu de 3 hooks parallèles
- Backoff 30s entre tentatives de restore échouées (au lieu de retry à chaque event)

---

### 🟡 P2 — Visio & médias

**7. Appels visio**
- Ajouter un timeout de 5s sur `ensureFreshCallSession` avec fallback (toast "Réessayez")
- Logger précisément l'étape qui bloque (key gen / signal / livekit token)
- État loading visible sur le bouton appel (évite "rien ne se passe")

**8. Envoi photo**
- Diagnostic du toast "Erreur envoi photo" : log de l'erreur réelle (R2 signature ? MIME ? taille ?)
- Compression côté client systématique avant upload (réduit les échecs réseau)
- Retry auto 1x avant de montrer l'erreur

---

### 🟢 P3 — Performance & DX

**9. ML pipeline**
- Vérifier que `ml-twotower-train` ne timeout plus (cron logs)
- Limiter le batch à 5000 events si > 60s exec time

**10. Observabilité**
- Endpoint `/api/health` qui agrège : queue size, IndexedDB OK, sessions actives
- Dashboard admin : graphique erreurs E2EE par heure

**11. Bundle**
- Lazy-load les pages lourdes (Marketplace, Games, Live) si pas déjà fait
- Audit des imports `lucide-react` (preferer named imports)

---

### Recommandation d'exécution

Je propose d'attaquer **P0 (1 → 3)** dans cette session — ce sont les vraies sources de douleur visibles dans tes logs récents. Les P1 et P2 demandent plus de travail et méritent leurs propres sessions dédiées pour bien tester.

**Veux-tu que je démarre par P0 maintenant ?** Si tu préfères un autre ordre (ex: visio en premier car bloquant pour les utilisateurs), dis-le moi.