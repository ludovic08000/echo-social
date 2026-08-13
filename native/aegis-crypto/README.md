# Aegis Crypto Native

Bridge natif Aegis au-dessus de la copie auditée de libsignal Rust.

## Frontière

- Le record d'identité et le record SPK sont secrets et doivent être scellés
  immédiatement par ACE/Keychain, Android Keystore ou Windows Hello.
- Les clés publiques et signatures peuvent être envoyées aux RPC Aegis.
- L'API et Supabase ne chargent jamais cette bibliothèque pour déchiffrer.

## Compilation Windows

```powershell
cmd /c 'call "C:\BuildTools\VC\Auxiliary\Build\vcvars64.bat" && cargo build --release'
```

Le même crate produit une bibliothèque statique pour Swift/iOS et une base
`cdylib` pour Windows. Android utilise la même logique derrière JNI. Les
façades initiales se trouvent dans `bindings/`.

Windows Web utilise la cible `wasm32-unknown-unknown`. Les bindings générés
sont chargés par `src/lib/crypto/aegisWasmBridge.ts`; l'entropie provient de
`crypto.getRandomValues` via les backends JavaScript de `getrandom`.

## Contrat avec le serveur Aegis

La réponse `identity_generate` est séparée volontairement :

- `secretRecord` reste dans le vault matériel du device ;
- `publicKey` peut être publiée dans le bundle du device ;
- pour une SPK, seul `publicKey + signature + keyId` est publié ;
- le record SPK complet reste dans le vault et alimente le futur SessionStore.

Le prochain incrément du bridge implémentera les stores libsignal durables et
les appels `process_prekey_bundle`, `message_encrypt` et `message_decrypt`.
