# Flux de réinitialisation d'identité cryptographique (Aegis)

Ce document décrit le flux explicite de réinitialisation d'identité E2EE introduit
par la PR #57.

## Invariant principal

Aucune identité cryptographique n'est **jamais** créée, remplacée ou écrasée
automatiquement. Toute création d'une nouvelle identité alors qu'une identité
serveur existe déjà exige une action explicite de l'utilisateur, la saisie de son
mot de passe de compte et la confirmation du changement d'empreinte.

## États détectés

`inspectAccountCryptoState()` (`src/lib/crypto/accountCryptoState.ts`) compare
l'état local (IndexedDB) et l'état serveur (clés publiques, empreintes) et
retourne un état parmi :

| État | Signification | Écran affiché |
| --- | --- | --- |
| `READY` | Identité locale présente et cohérente avec le serveur | Passage au PIN |
| `NO_IDENTITY` | Aucune identité locale ni serveur | Création normale (onboarding chiffrement) |
| `RESTORABLE_IDENTITY` | Identité serveur + sauvegarde disponible | `IdentityRestoreScreen` |
| `UNRECOVERABLE_SERVER_IDENTITY` | Identité serveur sans clé privée ni sauvegarde exploitable | `IdentityResetScreen` |
| `INCONSISTENT` | Incohérence non résoluble (fail-closed) | `IdentityInconsistentScreen` |

La logique est **fail-closed** : en cas de doute, la messagerie reste verrouillée
et aucune clé n'est générée.

## Parcours utilisateur

```text
Ouverture messagerie
        |
        v
  inspectAccountCryptoState()
        |
  +-----+-----------------------------+
  |           |            |          |
READY   RESTORABLE   UNRECOVERABLE  INCONSISTENT
  |           |            |          |
  |     Restaurer     "Créer une      Écran bloquant
  |     (mot de passe  nouvelle       (réessayer)
  |      ou clé)       identité
  |           |        sécurisée")
  |           |            |
  |           |      mot de passe + case
  |           |      "Je comprends que mon
  |           |       empreinte va changer"
  |           |            |
  |           +------------+
  |                        |
  v                        v
Création / saisie du PIN de messagerie
        |
        v
     Messagerie
```

## Réinitialisation

`resetUnrecoverableIdentityWithPassword()`
(`src/lib/crypto/explicitIdentityReset.ts`) :

1. vérifie le mot de passe via l'authentification Lovable Cloud ;
2. archive les anciens enregistrements d'identité (`is_active = false`), sans
   suppression destructive ;
3. génère une nouvelle identité et initialise la sauvegarde Master Key ;
4. applique un verrou *single-flight* : deux appels concurrents ne peuvent pas
   produire deux identités.

Après succès, l'état repasse en `READY` et l'utilisateur enchaîne sur la
création du PIN.

## Déduplication des fenêtres de récupération

`recoveryDialogCoordinator.ts` expose `acquireRecoveryDialog(owner)` /
`releaseRecoveryDialog(owner)`. Le portail d'identité prend le verrou
(`messaging-identity-gate`) tant qu'un de ses écrans est monté ; les autres
prompts (dont `E2EERestorePromptDialog`) ne s'affichent pas pendant ce temps.
Une seule fenêtre de récupération est donc visible à la fois.

## Tests

- `src/components/messaging/__tests__/identityResetFlow.test.tsx` — branches UI,
  exigence mot de passe + confirmation, single-flight.
- `src/lib/crypto/__tests__/` — conformité cryptographique existante.
