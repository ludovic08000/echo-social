# Messages longs — alignement Signal

Aegis suit désormais le modèle de transport utilisé par Signal Desktop pour les corps texte longs :

- jusqu’à 2 Kio UTF-8, le texte reste dans le corps E2EE normal ;
- au-delà de 2 Kio et jusqu’à 64 Kio UTF-8, le texte complet devient une pièce jointe `text/x-signal-plain` chiffrée côté client avec une clé AES-256-GCM unique ;
- le Double Ratchet transporte un manifeste authentifié contenant un aperçu Unicode sûr, l’URL opaque, la clé de fichier et la taille attendue ;
- la pièce jointe est liée à l’identifiant immuable du message par l’AAD AES-GCM ;
- le destinataire télécharge, authentifie et déchiffre le blob avant de mettre le texte complet en cache ;
- un message long reste un seul message logique et ne consomme qu’une seule clé de message Double Ratchet par appareil.

Aegis adapte ce principe à son stockage R2/Supabase. Il ne reprend pas le protocole réseau, les CDN ni les formats protobuf privés de Signal.
