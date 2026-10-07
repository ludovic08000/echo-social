# DB-IP City Lite pour Lovable Cloud

Intégration gratuite côté fournisseur, **pas une promesse d'hébergement gratuit**.
Ne pas activer avant vérification des quotas disponibles de stockage, de bande
passante et d'exécution Lovable Cloud. Aucun abonnement, aucune API payante et
aucun nouveau projet backend ne sont créés. Cette intégration ne change pas
`login-security`, l'approbation des appareils, Aegis ou Libsignal.

## Données et langues

Source officielle : https://db-ip.com/db/download/ip-to-city-lite
Format : https://db-ip.com/db/format/ip-to-city-lite/mmdb.html

Utiliser **City Lite MMDB**, pas le CSV anglais seul. Le lecteur conserve tous
les noms disponibles en `en`, `fr`, `de`, `es`, `pt-BR`, `zh-CN`, `ja`, `ru`,
`fa`, `ko`. Les sous-locales du navigateur sont normalisées ; un nom absent
retombe sur anglais, français, puis un nom disponible. Cela traduit les lieux
disponibles, pas les articles ni l'application entière. Les valeurs de ciblage
restent canoniques quel que soit le nom affiché.

Licence CC BY 4.0, attribution avec lien DB-IP dans les réglages, le panneau
actualités et les cartes publicitaires. Le manifeste conserve licence, origine
et transformations. Pas de coordonnées exportées. DB-IP ne reçoit jamais l'IP
du visiteur. City Lite ne fournit pas de détection fiable de VPN/mobile : une
ville IP n'est **jamais une position physique vérifiée**, ni un signal suffisant
pour autoriser/refuser une connexion. Saisie manuelle toujours prioritaire.

## Préparation hors ligne

Télécharger le fichier mensuel sur le site officiel **après acceptation de la
licence**. Vérifier l'empreinte publiée ; ne pas committer le fichier.
Exemple PowerShell (environnement isolé, pas d'installation Python globale) :

```powershell
python -m venv .geoip-venv
.geoip-venv/Scripts/python -m pip install -r scripts/geoip/requirements.txt
.geoip-venv/Scripts/python scripts/geoip/build_dbip_lite.py <fichier.mmdb.gz> --edition 2026-10
python -m unittest discover -s scripts/geoip -p 'test_*.py' -v
node scripts/geoip/upload-dbip-lite.mjs .geoip-build/<release>
```

Le dernier appel valide **localement uniquement**, sans réseau. Le convertisseur
lit en mémoire mappée, trie sur disque SQLite et produit des fragments de
256 Kio maximum (2 048 plages maximum), un index borné à 8 Mio et un rapport
de couverture des noms par langue. Un seul processus ; prévoir la place disque
pour l'original, le tri temporaire et les fragments. Ne pas compiler une base
mondiale dans une Edge Function ou dans le navigateur.

## Activation contrôlée, jamais implicite

1. Déployer les prérequis discovery/news/ad-location déjà préparés et valider
   leur schéma sur **Lovable Cloud**, sans publier les autres modifications
   locales du dépôt en bloc. Cette intégration n'ajoute aucune migration SQL.
2. Vérifier la taille réelle dans `report.json` et les quotas **encore libres**
   du projet (prévoir aussi l'ancienne édition et les requêtes). Si ces quotas
   ne suffisent pas, rester désactivé : aucune montée en gamme automatique.
3. Créer le bucket **privé** `geoip-lite` dans le projet Lovable existant, sans
   politique de lecture/écriture publique ou authentifiée. Limite d'objet au
   moins 8 Mio pour le manifeste ; aucun upload client. Le rôle serveur seul
   accède à la base. Ne jamais ajouter la clé serveur aux variables `VITE_*`.
4. Fournir `LOVABLE_CLOUD_SERVICE_ROLE_KEY` dans l'environnement opérateur,
   puis appeler le script avec `--upload --max-bytes=<capacité_autorisée_en_octets>`.
   Le script cible uniquement le backend Lovable existant, refuse un bucket
   public, n'écrase rien, vérifie les conflits lors d'une reprise et publie
   le manifeste en dernier. Il **n'active pas** la géolocalisation.
5. Configurer les deux valeurs de `report.json` dans les secrets Cloud :
   `DBIP_LITE_RELEASE`, `DBIP_LITE_MANIFEST_SHA256`. Déployer les fonctions
   `local-media-location`, `ad-location` et le frontend avec attribution.
6. Tester en préproduction qu'un en-tête IP est vraiment **écrasé par la
   passerelle**, y compris quand le client envoie une fausse IP. Ensuite
   seulement renseigner `LOCAL_MEDIA_TRUSTED_IP_HEADER` et/ou
   `ADS_LOCATION_TRUSTED_IP_HEADER`. Ne pas supposer que le Cloudflare du site
   frontend transmet ses métadonnées au backend Lovable.
7. Tester deux comptes, retrait du consentement, compte mineur, changement de
   langue, profil, ville manuelle, connexion lente, IPv4/IPv6. Activer
   `DBIP_LITE_ENABLED=true` seulement après ces contrôles. Les interrupteurs
   `LOCAL_MEDIA_CONTEXT_ENABLED` et `ADS_LOCATION_AUTO_ENABLED` restent
   indépendants, et les règles serveur de consentement/majorité inchangées.

## Limites, mise à jour et retour arrière

La résolution reste hors du chemin bloquant du feed. Un index en cache et au
plus huit fragments par fonction ; quatre chargements simultanés maximum,
empreintes SHA-256, délais de deux secondes pour les lectures Storage et
temporisation des échecs. Aucun cache des IP individuelles, aucun appel DB-IP
par visiteur. La première lecture peut être plus lente : mesurer sur Lovable
avant de promettre 200–350 ms. Une base de plus de 100 jours est ignorée.

Pour chaque mise à jour mensuelle : télécharger, compiler, vérifier la
couverture/la taille, tester et uploader une **nouvelle édition immuable**,
puis changer la paire release/empreinte ensemble avec redéploiement des deux
fonctions. Pas de cron activé sans quotas et chaîne d'import validés.

Retour arrière immédiat : `DBIP_LITE_ENABLED=false`, redéployer les fonctions,
ou réépingler ensemble une édition validée et son empreinte. Le profil, les
choix manuels et les contenus généraux restent disponibles. Aucune suppression
de compte, clé, archive ou message n'est nécessaire. Les anciennes éditions
ne sont pas supprimées automatiquement.

## État de livraison

Code préparé localement, licence acceptée et base officielle téléchargée.
Les crédits existants sont autorisés avec un plafond total de 10 crédits
pour la mise en place et les tests (réponse utilisateur du 7 octobre 2026).
Aucun achat ni recharge. Le bucket,
la provenance de l'IP et le parcours réel Lovable doivent encore être validés
avant activation. Les tests ne certifient pas l'exactitude géographique de
la ville estimée à partir d'une IP.

Validation locale initiale du 7 octobre 2026, avant l'import réel :

- Vitest : 216 fichiers réussis, 1 243 tests réussis et 3 ignorés. Inclut
  l'interopérabilité convertisseur Python → fragments → lecteur TypeScript
  → validation locale de l'uploader, ainsi que les cas IPv4/IPv6 et langues.
- Convertisseur Python : 4 tests réussis ; aucune base mondiale réelle
  téléchargée ou importée pendant cette validation.
- Échanges réels WASM Libsignal : six directions entre trois identités
  réussies, avec contrôles de rejeu, renouvellement et substitution d'identité.
- TypeScript, vérification Deno des deux fonctions, build Vite et frontière
  navigateur Aegis réussis. Les avertissements de taille de bundles existants
  ne constituent pas une mesure de latence en production.
- Inspection Lovable Cloud en lecture seule : la consommation est visible,
  mais la capacité gratuite restante nécessaire à cet import n'est pas
  établie. Aucun achat, changement d'abonnement, upload ou déploiement effectué.

Accord utilisateur reçu le 7 octobre 2026 pour la licence CC BY 4.0 avec
attribution, puis case d'acceptation cochée sur le téléchargement City Lite.
Aucun abonnement à l'API Basic n'a été souscrit. Les interrupteurs restent
désactivés tant que les contrôles d'activation ne sont pas terminés.

Le fichier officiel d'octobre 2026 a été téléchargé. Les empreintes affichées
par DB-IP portent sur le **MMDB décompressé**, et non son archive gzip :
126 998 165 octets, SHA-1 `df17bd24390108ed1d24dcb7718dc60f6b9abd4f`,
MD5 `5966907981d3e82f338e823d1b83e002`, vérifiés tous deux. Les empreintes
SHA-256 du convertisseur restent utilisées pour l'intégrité des objets Cloud.

L'essai réel a corrigé le point d'entrée Python pour utiliser le symbole
public `maxminddb.MODE_AUTO` de la version 3.2.0 ; un test de régression couvre
ce point d'entrée (5 tests Python réussis après correction).

Vérification facultative, hors réseau, d'une édition compilée contre le MMDB :

```powershell
$env:DBIP_TEST_RELEASE = '.geoip-build/<release>'
$env:DBIP_TEST_DATABASE = '.geoip-build/downloads/dbip-city-lite-2026-10.mmdb'
$env:DBIP_TEST_PYTHON = '.geoip-venv/Scripts/python.exe'
node --max-old-space-size=3072 node_modules/vitest/vitest.mjs run src/test/dbipReleaseSmoke.test.ts --maxWorkers=1
```

Ce test compare des adresses publiques d'infrastructure IPv4/IPv6 dans les
dix langues et vérifie la stabilité des clés de ciblage. Sans les variables
d'opt-in, il est ignoré ; aucune base sous licence n'est ajoutée au dépôt.

Contrôle Cloud après accord : le panneau « Free usage included » affiche
**0 / 20 monthly Cloud credits left** au 7 octobre 2026. Un solde de crédits
du forfait est présent, mais ce n'est pas un quota Cloud gratuit disponible.
Ne pas uploader ni activer sans renouvellement du quota gratuit, ou autorisation
explicite d'utiliser le solde existant avec un plafond. Aucun achat, changement
d'abonnement ni recharge n'est autorisé par le seul accord sur la licence.

Contrôles après accord : 216 fichiers Vitest réussis, 1 243 tests réussis et
4 ignorés (dont le test réel opt-in), 5 tests Python réussis, vérifications
TypeScript application/outillage, build Vite/PWA et frontière navigateur Aegis
réussis. Les six directions du test WASM Libsignal ont également réussi.
Sous Windows, les tests Python ont nécessité l'autorisation de créer leurs
fichiers temporaires hors du bac à sable ; les échecs d'accès ne sont pas des
échecs fonctionnels du convertisseur.

Le premier import mondial dans `.geoip-build/2026-10-9e250f02722d` s'est
interrompu avant le manifeste et n'a produit aucun objet publiable. La relance
isolée est terminée dans `.geoip-build/retry/2026-10-9e250f02722d` :
14 297 593 plages, 7 192 objets (manifeste inclus), 1 332 927 212 octets et
manifeste SHA-256
`6b9dc39bde4c3d513941ef4ad26f3a8b9a9249f27e59d9d52397fbb2fe32b631`.
La validation locale intégrale de l'uploader réussit. Le test réel compare cinq
adresses publiques IPv4/IPv6 au MMDB officiel dans les dix langues et réussit
(1 fichier, 1 test, 191 ms). Cette taille de 1,33 Go doit être traitée comme un
signal de capacité et de coût : aucun upload n'est autorisé tant que le coût
prévisionnel ne peut pas être borné sous les 10 crédits et que le schéma Cloud
n'est pas complet. Aucun upload, déploiement, commit ou push n'a été effectué.

Après accord utilisateur, un profil allégé a été ajouté : détail ville/région
pour `FR`, `GF`, `GP`, `MQ`, `RE`, `YT`, et pays seulement ailleurs. Les plages
adjacentes qui pointent vers le même lieu sont fusionnées. L'identifiant de
release dérive désormais du fichier source **et** du profil de transformation,
afin d'interdire toute collision entre l'édition complète et l'édition allégée.

Résultat réel : `.geoip-build/slim/2026-10-d20ae140968b`, 14 297 593 plages
sources réduites à 452 149 plages IPv4 et 437 303 plages IPv6, 468 objets,
80 507 737 octets (environ 94 % de moins). Manifeste SHA-256 :
`a3f4ee56e0f53c549adcea929fe8d3bb6c077ce1c3d4892f9af6ed6bd8ced4f1`.
La validation locale intégrale de l'uploader et le test réel MMDB → lecteur Edge
réussissent. Les pays restent traduits dans les dix langues disponibles ; DB-IP
City Lite ne fournit les noms de ville/région qu'en anglais pour cette édition,
donc l'interface applique le repli documenté au lieu d'inventer une traduction.
L'édition reste locale et désactivée jusqu'au déploiement des prérequis Cloud.

Accord complémentaire utilisateur : « oui utilise » autorise l'utilisation
des crédits Lovable existants pour cette intégration, sans achat ni recharge.
Plafond confirmé ensuite par l'utilisateur : **10 crédits maximum** pour la
mise en place et les tests. Relever le solde de départ et vérifier les moyens
de respecter ce plafond avant de lancer les opérations Cloud. Ne pas confondre
un plafond en crédits avec `--max-bytes`, qui limite uniquement la taille des
objets de l'import. L'import local continue indépendamment.

Contrôles de préparation Cloud du 7 octobre après confirmation des 10 crédits :

- Solde général observé au départ : 203,67 crédits, plus 5 crédits quotidiens
  de construction. C'est un solde partagé, pas un compteur isolé de cette tâche.
- Le précontrôle SQL `scripts/check-location-schema.sql`, exécuté dans
  l'éditeur **Lovable Cloud** en lecture seule, renvoie cinq valeurs `false` :
  `discovery_preferences`, `ad_location_contexts`, `media_partners`,
  `get_my_ad_location_context()` et `cleanup_discovery_data()` sont absents.
  Ne pas activer la fonction sur ce schéma incomplet.
- Les migrations préparées passent 282 contrôles fonctionnels sur une base
  PGlite isolée via `node scripts/test-discovery-database.mjs` : 78 discovery,
  39 RSS, 39 média régional, 53 discussions et 73 ciblage local. Ce résultat
  n'établit pas à lui seul la compatibilité avec toutes les données de production.
- Le bucket `geoip-lite` n'est pas présent dans le panneau Storage.
  L'environnement opérateur n'a pas de `LOVABLE_CLOUD_SERVICE_ROLE_KEY`.
  Ne jamais copier une clé serveur dans une conversation ou le frontend.
- Le dialogue de limite projet Lovable indique qu'un blocage à épuisement
  interrompt également Cloud et l'IA du projet entier. Il a été **annulé**,
  sans limite enregistrée : un plafond de tâche n'autorise pas à couper le site.
  L'affichage des consommations peut être différé ; le contrôle par solde seul
  n'est pas une garantie technique de ne jamais dépasser 10 crédits.
- Aucun achat, recharge, changement d'abonnement, upload, migration de production
  ou déploiement n'a été effectué. La dépense d'exploitation ultérieure ne doit
  pas être assimilée au budget ponctuel d'installation et de tests.
