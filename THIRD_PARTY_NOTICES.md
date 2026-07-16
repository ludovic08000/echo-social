# Third-party notices

## Signal Desktop

Sesame contains adapted user-interface logic from Signal Desktop:

- `src/components/messages/SesameMessageMetadata.tsx`
  - adapted from `ts/components/conversation/MessageMetadata.dom.tsx`
  - Copyright 2018 Signal Messenger, LLC
- `src/components/messages/SesameDeliveryIssueNotice.tsx`
  - adapted from `ts/components/conversation/DeliveryIssueNotification.dom.tsx`
  - Copyright 2021 Signal Messenger, LLC

Original project: Signal Desktop, maintained by Signal Messenger, LLC.

License: GNU Affero General Public License version 3 only (`AGPL-3.0-only`).

The adapted files were modified for the Sesame web messaging architecture on 2026-07-16. They replace Signal-specific Electron, Redux, localization and component dependencies with Sesame's React, Supabase and local message-queue interfaces.

Sesame is an independent project. It is not affiliated with, endorsed by, or distributed by Signal Messenger, LLC. No Signal logo, wordmark or other brand asset is included.
