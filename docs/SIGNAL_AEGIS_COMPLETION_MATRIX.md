# Signal / Aegis completion matrix

Aegis is an independent protocol and is not wire-compatible with Signal clients.
This matrix tracks the Signal/Sesame security properties adopted by Aegis.

| Property | Aegis status | Executable evidence |
| --- | --- | --- |
| Account-authorized device identity | Complete | `signalStyleRouteValidation.test.ts`, `sesameDeviceIdentity.test.ts` |
| Atomic SPK/OPK publication and OPK claim | Complete | `x3dhOpkClaim.test.ts` |
| X3DH initiator/responder bootstrap | Complete | `deviceRatchet.test.ts`, `iosX3dhResponderBootstrapVault.test.ts` |
| Independent Double Ratchet per ordered device pair | Complete | `multiDeviceIntegration.test.ts` |
| Authenticated ratchet headers, replay rejection and skipped keys | Complete | `signalProtocolHardening.test.ts`, `deviceRatchet.test.ts` |
| Sesame active/inactive session handling | Complete | `multiDeviceIntegration.test.ts` |
| Canonical device route and session reconciliation | Complete | `deviceRegistryCache.test.ts`, `multiDeviceIntegration.test.ts` |
| Exact all-device fan-out with one route refresh | Complete | `multiDeviceFanoutSecurity.test.ts` |
| Durable retry without plaintext downgrade | Complete | `fanoutSessionTransaction.test.ts`, `aegisCrossPlatformDeviceCopy.test.ts` |
| iOS, Android and Windows lifecycle and vault isolation | Complete | platform lifecycle tests and device vault contracts |
| No decrypted-history transfer in account/device backup | Complete | `accountBackupNoPlaintextContract.test.ts` |
| WASM bridge wire validation | Complete | `aegisWasmBridge.test.ts` |
| PQXDH / post-quantum bootstrap | Deferred | Browser deployment intentionally reports unavailable |

The post-quantum row is deliberately excluded until the browser runtime and the
deployed native/WASM bridge can support it consistently without a compatibility
fallback.
