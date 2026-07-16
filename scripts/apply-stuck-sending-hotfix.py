from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 anchor, found {count}")
    return text.replace(old, new, 1)


# 1) Bound Web Locks acquisition. Aborting a pending lock request is safe: the
# cryptographic task never starts, so the Double Ratchet cannot advance invisibly.
path = Path('src/lib/messaging/signalWebConversationQueue.ts')
text = path.read_text()
text = replace_once(
    text,
    "const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;\nconst MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;\n",
    "const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;\nconst MAX_RETRY_ATTEMPTS = RETRY_DELAYS_MS.length;\nconst LOCK_ACQUIRE_TIMEOUT_MS = 12_000;\n\nexport class SignalConversationLockTimeoutError extends Error {\n  readonly code = 'E2EE_ENCRYPT_LOCK_TIMEOUT';\n\n  constructor() {\n    super('E2EE encryption lock timeout — automatic retry scheduled');\n    this.name = 'SignalConversationLockTimeoutError';\n  }\n}\n",
    'lock timeout constants',
)
text = replace_once(
    text,
    "export async function runSignalConversationJob<T>(\n  conversationKey: string,\n  task: () => Promise<T>,\n): Promise<T> {\n  if (hasWebLocks()) {\n    return navigator.locks.request(lockName(conversationKey), { mode: 'exclusive' }, task);\n  }\n  return runWithMemoryLock(conversationKey, task);\n}\n",
    "export async function runSignalConversationJob<T>(\n  conversationKey: string,\n  task: () => Promise<T>,\n): Promise<T> {\n  if (hasWebLocks()) {\n    const controller = new AbortController();\n    const timer = setTimeout(() => controller.abort(), LOCK_ACQUIRE_TIMEOUT_MS);\n    try {\n      return await navigator.locks.request(\n        lockName(conversationKey),\n        { mode: 'exclusive', signal: controller.signal },\n        task,\n      );\n    } catch (error) {\n      if (controller.signal.aborted) throw new SignalConversationLockTimeoutError();\n      throw error;\n    } finally {\n      clearTimeout(timer);\n    }\n  }\n  return runWithMemoryLock(conversationKey, task);\n}\n",
    'abortable web lock',
)
path.write_text(text)


# 2) Make every send stage explicit and ensure all failure paths leave `sending`.
path = Path('src/hooks/useMessageQueueSignal.ts')
text = path.read_text()
text = replace_once(
    text,
    "function isAuthenticationError(error: unknown): boolean {\n  const text = normalizedErrorText(error);\n  return (\n    text.includes('401') ||\n    text.includes('jwt') ||\n    text.includes('not_authenticated') ||\n    text.includes('unauthorized')\n  );\n}\n\nfunction isAmbiguousTransportError(error: unknown): boolean {\n",
    "function isAuthenticationError(error: unknown): boolean {\n  const text = normalizedErrorText(error);\n  return (\n    text.includes('401') ||\n    text.includes('jwt') ||\n    text.includes('not_authenticated') ||\n    text.includes('unauthorized')\n  );\n}\n\nconst SEND_TRANSPORT_TIMEOUT_MS = 15_000;\nconst SEND_CONFIRM_TIMEOUT_MS = 6_000;\nconst IDENTITY_PREWARM_TIMEOUT_MS = 5_000;\n\nasync function withSendStageTimeout<T>(\n  operation: PromiseLike<T>,\n  timeoutMs: number,\n  stage: string,\n): Promise<T> {\n  let timer: ReturnType<typeof setTimeout> | undefined;\n  const timeout = new Promise<never>((_, reject) => {\n    timer = setTimeout(() => reject(new Error(`${stage} timeout`)), timeoutMs);\n  });\n  try {\n    return await Promise.race([Promise.resolve(operation), timeout]);\n  } finally {\n    if (timer !== undefined) clearTimeout(timer);\n  }\n}\n\nexport function classifyOutboundFailure(error: unknown): {\n  status: 'retry_pending' | 'failed_visible';\n  message: string;\n} {\n  const raw = error instanceof Error ? error.message : String(error ?? 'Échec de l’envoi chiffré.');\n  const text = normalizedErrorText(error);\n  const permanent = isAuthenticationError(error) || [\n    'verification obligatoire',\n    'fingerprint changed',\n    'safety number',\n    'cle de securite du contact modifiee',\n    'pin unlock required',\n    'identity_lost_backup_available',\n  ].some(marker => text.includes(marker));\n  return {\n    status: permanent ? 'failed_visible' : 'retry_pending',\n    message: isAuthenticationError(error)\n      ? 'Session expirée — reconnectez-vous pour envoyer.'\n      : raw || 'Échec de l’envoi chiffré.',\n  };\n}\n\nfunction isAmbiguousTransportError(error: unknown): boolean {\n",
    'send timeout helpers',
)
text = replace_once(
    text,
    "      status: resumePayload ? 'retry_pending' : 'sending',\n",
    "      status: resumePayload ? 'retry_pending' : 'pending_local',\n",
    'optimistic pending status',
)
text = replace_once(
    text,
    "    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;\n",
    "    const encryptionWasRequired = isEncryptionActive && !allowPlaintext;\n    updatePending({\n      status: encryptionWasRequired ? 'encrypting' : 'sending',\n      lastError: null,\n    });\n",
    'explicit encrypting status',
)
text = replace_once(
    text,
    "await ensureUserE2EEIdentity(user.id, { waitForMaintenance: false });\n",
    "await withSendStageTimeout(\n  ensureUserE2EEIdentity(user.id, { waitForMaintenance: false }),\n  IDENTITY_PREWARM_TIMEOUT_MS,\n  'identity prewarm',\n);\n",
    'identity prewarm timeout',
)
text = replace_once(
    text,
    "        if (!resumedDirectBody) {\nif (!encrypt) throw new Error('Chiffrement direct indisponible.');\nconst directBody = await encrypt(transportPlaintext, localId);\nif (!directBody || directBody === transportPlaintext || isMultiDeviceParentBody(directBody)) {\n  throw new Error('Enveloppe E2EE directe invalide.');\n}\nbodyToStore = directBody;\n        }\n",
    "        if (!resumedDirectBody) {\n          updatePending({ status: 'encrypting', lastError: null });\n          try {\n            if (!encrypt) throw new Error('Chiffrement direct indisponible.');\n            const directBody = await encrypt(transportPlaintext, localId);\n            if (!directBody || directBody === transportPlaintext || isMultiDeviceParentBody(directBody)) {\n              throw new Error('Enveloppe E2EE directe invalide.');\n            }\n            bodyToStore = directBody;\n          } catch (error) {\n            const failure = classifyOutboundFailure(error);\n            updatePending({\n              status: failure.status,\n              lastError: failure.message,\n            }, { preparedCopies: [] });\n            trace('direct_e2ee_failed', {\n              error: failure.message,\n              retryable: failure.status === 'retry_pending',\n            });\n            throw error instanceof Error ? error : new Error(failure.message);\n          }\n        }\n",
    'direct encryption catch',
)
text = text.replace(
    "        await savePlaintextForCiphertext(bodyToStore, sanitized);\n",
    "        void savePlaintextForCiphertext(bodyToStore, sanitized).catch(() => {});\n",
)
text = replace_once(
    text,
    "    if (deliveryMode === 'direct') {\n      const { data: inserted, error: insertError } = await supabase\n        .from('messages')\n        .insert({\n",
    "    if (deliveryMode === 'direct') {\n      let insertResponse: { data: unknown; error: unknown };\n      try {\n        insertResponse = await withSendStageTimeout(\n          Promise.resolve(supabase\n            .from('messages')\n            .insert({\n",
    'direct insert timeout start',
)
text = replace_once(
    text,
    "        } as never)\n        .select('id')\n        .single();\n\n      const insertedRow = inserted as { id?: string } | null;\n",
    "            } as never)\n            .select('id')\n            .single()),\n          SEND_TRANSPORT_TIMEOUT_MS,\n          'message transport',\n        ) as { data: unknown; error: unknown };\n      } catch (error) {\n        const failure = classifyOutboundFailure(error);\n        updatePending({ status: failure.status, lastError: failure.message }, {\n          encryptedBody: bodyToStore,\n          preparedCopies: [],\n        });\n        throw error instanceof Error ? error : new Error(failure.message);\n      }\n\n      const { data: inserted, error: insertError } = insertResponse;\n      const insertedRow = inserted as { id?: string } | null;\n",
    'direct insert timeout end',
)
text = replace_once(
    text,
    "        const { data: existing } = await supabase\n.from('messages')\n.select('id,sender_id,conversation_id')\n.eq('id', serverMessageId)\n.maybeSingle();\n",
    "        let existing: unknown = null;\n        try {\n          const confirmation = await withSendStageTimeout(\n            Promise.resolve(supabase\n              .from('messages')\n              .select('id,sender_id,conversation_id')\n              .eq('id', serverMessageId)\n              .maybeSingle()),\n            SEND_CONFIRM_TIMEOUT_MS,\n            'message confirmation',\n          ) as { data: unknown };\n          existing = confirmation.data;\n        } catch (confirmationError) {\n          const failure = classifyOutboundFailure(confirmationError);\n          updatePending({ status: 'retry_pending', lastError: failure.message }, {\n            encryptedBody: bodyToStore,\n            preparedCopies: [],\n          });\n          throw confirmationError instanceof Error\n            ? confirmationError\n            : new Error(failure.message);\n        }\n",
    'direct confirmation timeout',
)
text = replace_once(
    text,
    "        const existingRow = existing as {\nid: string;\nsender_id: string;\nconversation_id: string;\n        } | null;\n",
    "        const existingRow = existing as {\nid: string;\nsender_id: string;\nconversation_id: string;\n        } | null;\n",
    'existing row anchor',
)
text = replace_once(
    text,
    "    if (encryptedSuccessfully) {\n      await Promise.all([\n        savePlaintext(data.id, sanitized),\n        savePlaintextForCiphertext(bodyToStore, sanitized),\n      ]);\n      dispatchDecryptRetry(data.id);\n      scheduleBackgroundFanoutCoverage(data.id);\n    }\n",
    "    if (encryptedSuccessfully) {\n      // Delivery is already committed. Local readability caches are best-effort\n      // and must never keep the UI in `sending` if IndexedDB is slow on iOS.\n      void Promise.all([\n        savePlaintext(data.id, sanitized),\n        savePlaintextForCiphertext(bodyToStore, sanitized),\n      ]).catch(() => {});\n      dispatchDecryptRetry(data.id);\n      scheduleBackgroundFanoutCoverage(data.id);\n    }\n",
    'nonblocking post-send cache',
)
text = replace_once(
    text,
    "    await deleteOutboxPayload(localId).catch(() => {});\n    setPendingMessages(prev => prev.filter(message => message.localId !== localId));\n    void Promise.resolve(onMessageSent?.(localId)).catch(callbackError => {\n",
    "    setPendingMessages(prev => prev.filter(message => message.localId !== localId));\n    // Remove the visible pending state immediately after server acknowledgement.\n    // A slow IndexedDB delete is harmless: restore reconciliation checks the same\n    // stable server UUID and removes an already-delivered row idempotently.\n    void deleteOutboxPayload(localId).catch(() => {});\n    void Promise.resolve(onMessageSent?.(localId)).catch(callbackError => {\n",
    'nonblocking outbox cleanup',
)
path.write_text(text)


# 3) Add focused regression tests for the status classifier and lock timeout.
path = Path('src/hooks/__tests__/useMessageQueueArchive.test.ts')
text = path.read_text()
text = replace_once(
    text,
    "import { buildMultiDeviceParentEnvelope, selectInitialDeliveryMode, shouldArchiveMessageBody } from '../useMessageQueue';\n",
    "import { buildMultiDeviceParentEnvelope, selectInitialDeliveryMode, shouldArchiveMessageBody } from '../useMessageQueue';\nimport { classifyOutboundFailure } from '../useMessageQueueSignal';\n",
    'test import classifier',
)
text = replace_once(
    text,
    "  it('builds a valid encrypted-only multi-device parent envelope', () => {\n",
    "  it('retries transient encryption and lock failures instead of leaving sending stuck', () => {\n    expect(classifyOutboundFailure(new Error('E2EE encryption lock timeout — automatic retry scheduled'))).toMatchObject({\n      status: 'retry_pending',\n    });\n    expect(classifyOutboundFailure(new Error('Session Double Ratchet non prête'))).toMatchObject({\n      status: 'retry_pending',\n    });\n  });\n\n  it('keeps permanent identity and authentication failures visible', () => {\n    expect(classifyOutboundFailure(new Error('Cle de securite du contact modifiee - verification obligatoire avant envoi'))).toMatchObject({\n      status: 'failed_visible',\n    });\n    expect(classifyOutboundFailure(new Error('401 JWT unauthorized'))).toMatchObject({\n      status: 'failed_visible',\n      message: 'Session expirée — reconnectez-vous pour envoyer.',\n    });\n  });\n\n  it('builds a valid encrypted-only multi-device parent envelope', () => {\n",
    'classifier tests',
)
path.write_text(text)
