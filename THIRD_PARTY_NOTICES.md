# Third-party notices

## Signal Desktop

Aegis contains adapted user-interface, retry and message-state logic from Signal Desktop:

- `src/components/messages/AegisMessageMetadata.tsx`
  - adapted from `ts/components/conversation/MessageMetadata.dom.tsx`
  - Copyright 2018 Signal Messenger, LLC
- `src/components/messages/AegisDeliveryIssueNotice.tsx`
  - adapted from `ts/components/conversation/DeliveryIssueNotification.dom.tsx`
  - Copyright 2021 Signal Messenger, LLC
- `src/lib/messaging/aegisSendState.ts`
  - adapted from `ts/messages/MessageSendState.std.ts`
  - Copyright 2021 Signal Messenger, LLC
  - preserves Signal's monotonic `Pending → Sent → Delivered → Read → Viewed` semantics and extends them to Aegis group-send aggregation
- `src/lib/messaging/signalBackoff.ts`
  - adapted from `ts/util/exponentialBackoff.std.ts`
  - Copyright 2021 Signal Messenger, LLC
- `src/lib/messaging/signalRetryAfter.ts`
  - adapted from `ts/util/parseRetryAfter.std.ts`
  - Copyright 2021 Signal Messenger, LLC
- `src/lib/messaging/aegisDeliveryPolicy.ts`
  - inspired by the stable error taxonomy in `ts/textsecure/Errors.std.ts`
  - Copyright 2020 Signal Messenger, LLC
  - does not copy Signal's libsignal, Electron or service-specific error classes

Original project: Signal Desktop, maintained by Signal Messenger, LLC.

License: GNU Affero General Public License version 3 only (`AGPL-3.0-only`).

The adapted files were modified for the Aegis web messaging architecture on 2026-07-16. They replace Signal-specific Electron, Redux, localization, libsignal and component dependencies with Aegis's React, Supabase and local message-queue interfaces.

Aegis is an independent project. It is not affiliated with, endorsed by, or distributed by Signal Messenger, LLC. No Signal logo, wordmark or other brand asset is included.
