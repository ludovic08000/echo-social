# Bouclier IA anti-attaques (AI Threat Shield)

Aujourd'hui la stack a du rate-limit IP, des bans, de la modération de contenu et un SOC qui *affiche* l'état. Mais rien n'analyse le **payload des requêtes en temps réel avec une IA** pour détecter et bloquer les attaques modernes. C'est ce qu'on ajoute.

## Ce qui sera réellement bloqué

L'IA (Gemini 2.5 via Lovable AI Gateway) classera chaque requête suspecte parmi :
- **SQL Injection** (UNION, OR 1=1, sleep(), pg_sleep, char encoding)
- **XSS / DOM injection** (`<script>`, `onerror=`, `javascript:`, payloads polymorphes)
- **Prompt injection** vers Zeus / agents IA ("ignore previous instructions", jailbreaks, exfiltration de system prompt)
- **SSRF / Path traversal** (`../`, `file://`, `gopher://`, IP internes)
- **Credential stuffing & brute force** (vélocité + UA suspects + listes connues)
- **Scraping massif** (UA bot, fréquence, headers manquants, fingerprint headless)
- **Spam / fraude marketplace** (cartes test, comptes jetables, mass-DM)
- **NoSQL injection / template injection** (`{{7*7}}`, `$where`, `$ne`)

## Architecture

```text
Client (hooks sensibles)        Edge Functions               DB
─────────────────────────       ──────────────────────       ──────────────────────
auth, signup, message,    ──►   ai-threat-shield       ──►   security_incidents
post, comment, search,          (Gemini 2.5 + regex)         banned_ips
checkout, ai-engine             │                            ddos_ip_tracker
                                ├── 1) regex pré-filtre      ai_engine_events
                                ├── 2) Gemini scoring        threat_decisions (new)
                                └── 3) action: allow/log/ban
```

## Composants

### 1. Edge function `ai-threat-shield`
- Reçoit : `endpoint`, `ip`, `user_id?`, `headers` (UA, referer), `payload_sample` (max 4 KB tronqué).
- **Étape 1 — pré-filtre regex** (sans coût IA) : 30+ signatures haute confiance → bloque immédiatement (latence < 5 ms).
- **Étape 2 — scoring IA Gemini 2.5 Flash** si suspect mais ambigu : retourne `{ category, confidence 0-100, reason, action }`.
- **Étape 3 — action automatique** :
  - `confidence ≥ 85` → insert `banned_ips` (24h) + `security_incidents` (severity critical) + log `ai_engine_events`.
  - `confidence 60-84` → `ddos_ip_tracker.penalty_level += 1` + alerte SOC.
  - `< 60` → log seulement (fine-tuning).
- Bypass admin (`ludovic43@msn.com`) et IPs allowlistées.
- Cache 60s par IP+endpoint pour éviter de re-scorer.

### 2. Table `threat_decisions` (nouvelle)
Trace toutes les décisions IA avec : `endpoint`, `ip`, `category`, `confidence`, `reason`, `action_taken`, `payload_hash`, `created_at`. RLS lecture admin seulement, retention 30 jours (cron).

### 3. Hook client `useThreatShield`
Wrapper léger autour de `supabase.functions.invoke` et des inputs sensibles (recherche, formulaire signup, post, message). N'envoie que les métadonnées + un échantillon haché si rien de suspect (privacy-first).

### 4. Intégration SOC (page AIEngine)
- Nouveau widget **"AI Threat Shield — Live"** : compteur attaques bloquées (1h/24h), top catégories, dernière décision IA, dernière IP bannie par l'IA.
- Bouton "Tester le bouclier" qui envoie un payload SQLi/XSS factice → confirme que la chaîne fonctionne en direct.

### 5. Pré-filtre runtime (browser)
Bloque côté client les payloads évidents avant envoi (UX rapide + économie d'appels), sans jamais faire confiance au client : la décision finale reste serveur.

## Coût & latence

- ~95% des requêtes : regex pré-filtre, **0 appel IA**, < 5 ms.
- ~5% suspectes : 1 appel Gemini 2.5 Flash, ~300-600 ms, < 0.0001 € / requête.
- Pas de surcoût visible utilisateur (asynchrone hors auth/checkout).

## Limites (transparence)

- Reste du **L7 applicatif** : pas de DPI réseau (impossible sans WAF type Cloudflare devant Lovable Cloud).
- L'IA n'est pas infaillible : les seuils sont conservateurs et tout est auditable dans `threat_decisions`.
- Le bypass humain admin reste prioritaire.

## Étapes d'implémentation

1. Migration DB : table `threat_decisions` + RLS + index + trigger purge 30j.
2. Edge function `ai-threat-shield` (regex + Gemini + actions).
3. Edge function `threat-shield-test` (auto-test santé du bouclier).
4. Hook `useThreatShield` + intégration dans signup, login, post, message, search, ai-engine.
5. Widget SOC "AI Threat Shield — Live" sur `/admin/ai-engine`.
6. Bouton "Test attaque" dans le SOC pour vérifier en 1 clic.

OK pour partir là-dessus ?
