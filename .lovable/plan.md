# Diagnostic : message vocal impossible sur forsure.fans (lecture seule)

## Constats (journaux accessibles, rien modifié)

- Les journaux sont accessibles.
- **Aucune requête HTTP vers `r2-upload` ou `r2-presign` sur les 48 dernières heures** (0 POST, 0 GET, 0 erreur). Aucune tentative d'envoi de vocal n'a donc laissé de trace d'upload côté serveur.
- `r2-upload` n'a qu'un démarrage/arrêt de routine (booted 13:49:06Z et 13:50:17Z, shutdown 13:52:26Z), sans aucune ligne applicative ni erreur.
- Sur les 3 dernières heures, les seuls appels aux fonctions sont `image-optimize` (200), `security-monitor` (200, plus un 401 à 13:45:03Z sans lien) et `livekit-token` (200 à 13:48:25Z et 13:50:32Z, tous les contrôles passés, donc un appel a bien eu lieu).
- Aucune erreur CORS, R2 ou d'authentification liée au vocal. Aucune insertion de message vocal n'est visible côté serveur.

**Conclusion :** la tentative de vocal s'arrête dans le navigateur, avant l'upload. Le serveur n'a jamais reçu le fichier.

## Causes possibles dans le code (non confirmées)

Chemin suivi : `VoiceRecorder` enregistre, chiffre, puis appelle `uploadToR2(..., 'voice', 'voice-<ts>.enc.<ext>')`. Ensuite `queue.sendMessage(body)` envoie le message.

1. **Échec avant l'upload** : l'accès au micro est refusé, `MediaRecorder` n'est pas pris en charge ou le blob est vide (fréquent sur iOS Safari/PWA). Le chiffrement du média (`encryptMedia`) peut aussi échouer. Dans ces cas, un toast « Erreur lors de l'envoi du vocal » s'affiche et aucune requête ne part.
2. **Session absente** : `uploadToR2` lève « Not authenticated » avant tout appel réseau.
3. **Blocage par le bouclier runtime / la CSP** d'un `fetch` vers la fonction, ce qui ne laisserait aucun log serveur.
4. **Contexte d'appel manqué** : l'invite vocale ne s'affiche qu'après un appel manqué (`livekit-token` a été appelé à 13:48 et 13:50). Il faut vérifier si l'utilisateur voulait parler de ce flux « Laisser un message vocal ? ».

## Étape proposée (après validation, toujours sans modifier de code)

- Reproduire le flux sur forsure.fans avec un navigateur automatisé : ouvrir une conversation, déclencher l'enregistrement (micro simulé), cliquer sur Envoyer. Capturer le texte exact du toast, les erreurs console et les requêtes réseau (bloquées ou non).
- Demander à l'utilisateur son appareil et son navigateur (iOS Safari, PWA, Windows), le message d'erreur affiché, et s'il s'agissait de la messagerie ou du message après appel manqué.
- Rapporter la cause confirmée et un correctif proposé, sans rien appliquer.
