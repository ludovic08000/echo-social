# ML auto-entraîné pour le bouclier (Gemini = oracle, ML = filtre rapide)

On transforme le bouclier en système **actif** qui apprend tout seul. Gemini reste l'oracle "vérité" qui label des exemples ; un petit modèle ML hébergé dans la DB devient le **premier filtre rapide** qui répond en < 5 ms sans appel IA, et qui s'améliore à chaque nouvelle attaque.

## Boucle d'apprentissage (active learning)

```text
Requête entrante
   │
   ▼
[1] Pré-filtre regex (signatures évidentes)
   │      ─► attaque évidente : ban + label "attack" (training)
   │
   ▼
[2] Modèle ML local (logistic régression online, 64 features)
   │      ─► confiance haute (≥ 0.85) : action directe, log
   │      ─► confiance basse (< 0.15)  : allow, log
   │
   ▼  (zone d'incertitude 0.15 - 0.85)
[3] Gemini 2.5 Flash décide → action + label "attack/benign"
   │
   ▼
[4] Sample sauvegardé dans threat_training_samples
   │
   ▼
[5] Cron nuit : threat-shield-train
        - Charge tous les samples labelés
        - Entraîne logistic régression (SGD, 200 époques)
        - Calcule precision/recall sur 10% holdout
        - Push weights dans threat_model_weights (versionné)
        - Si recall < ancien modèle, garde l'ancien
```

Résultat : après ~quelques jours, **80-90 % des requêtes sont décidées sans appel Gemini** (latence ÷ 100, coût ÷ 100), tout en gardant Gemini comme garde-fou pour les cas neufs/ambigus.

## Features extraites de chaque payload (64 dimensions)

- Comptes de caractères (`<`, `>`, `'`, `"`, `;`, `\`, `%`, ratio non-ASCII)
- Tokens dangereux (UNION, SELECT, script, onerror, ignore previous, ../, etc.)
- Entropie Shannon (encodage / obfuscation)
- Longueur normalisée (log) et ratio voyelles/consonnes
- Endpoint hashé (16 buckets)
- UA hashé (8 buckets : bot, mobile, headless, etc.)
- Heure (UTC, 24 buckets)
- Fréquence IP 1 min (depuis ddos_ip_tracker)
- Score regex précédent (si match)

Tout reste dans une fonction TS pure (pas de WASM, pas de dépendance lourde).

## Composants à créer

### Tables (migration)
- `threat_training_samples` : features (jsonb 64 floats), label (0/1), source (`regex` | `gemini` | `admin`), confidence, created_at
- `threat_model_weights` : version, weights (jsonb 64 floats), bias, accuracy, precision, recall, samples_used, trained_at, active (bool)

### Edge functions
- `threat-shield-train` (cron nuit + bouton manuel) : charge samples, entraîne, push nouveaux weights si meilleurs
- `ai-threat-shield` mis à jour : charge weights actifs (cache 60 s), score ML d'abord, fallback Gemini, sauve sample

### Feedback humain
- Boutons ✅ (vrai positif) / ❌ (faux positif) sur chaque ligne du widget AI Threat Shield → ajoute un sample labelé manuellement (poids ×3 dans l'entraînement)

### Widget SOC enrichi
- Version du modèle actif + accuracy / precision / recall
- Compteur "Décidé par ML" vs "Décidé par Gemini" sur 24 h
- Bouton "Réentraîner maintenant"
- Date du dernier entraînement réussi

## Garde-fous

- Si `samples_used < 200` → on n'active pas le modèle, Gemini gère tout
- Holdout 10 % obligatoire avant promotion d'un nouveau modèle
- Rollback automatique si recall chute > 5 pts
- Tous les weights versionnés (audit + rollback en 1 clic)

## Étapes

1. Migration : `threat_training_samples`, `threat_model_weights`, RLS admin, fonction `feature_extract` côté TS partagé.
2. Edge `threat-shield-train` (SGD logistic régression en pur TS).
3. Mise à jour `ai-threat-shield` : extraction features + scoring ML + active learning.
4. Cron pg_cron nightly (3h du mat).
5. Widget SOC : feedback ✅/❌, métriques modèle, bouton réentraînement.

OK pour implémenter ?
