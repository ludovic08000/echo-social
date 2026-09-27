const textEncoder = new TextEncoder()

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const maxLength = Math.max(leftBytes.length, rightBytes.length)
  let difference = leftBytes.length ^ rightBytes.length

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }

  return difference === 0
}

export function configuredServerSecretKeys(
  serializedSecretKeys: string | undefined,
  legacyServiceRoleKey: string | undefined
): string[] {
  const keys: string[] = []

  if (serializedSecretKeys) {
    try {
      const parsed = JSON.parse(serializedSecretKeys) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed)) {
          if (typeof value === 'string' && value.trim()) {
            keys.push(value.trim())
          }
        }
      }
    } catch {
      // Keep the legacy fallback available while projects migrate key formats.
    }
  }

  if (legacyServiceRoleKey?.trim()) {
    keys.push(legacyServiceRoleKey.trim())
  }

  return [...new Set(keys)]
}

export function presentedServerSecret(headers: Headers): string | null {
  const apiKey = headers.get('apikey')?.trim() || null
  const authorization = headers.get('Authorization')?.trim() || null
  const bearerMatch = authorization?.match(/^Bearer\s+(.+)$/i)
  const bearerKey = bearerMatch?.[1]?.trim() || null

  // Reject ambiguous requests instead of choosing one credential over another.
  if (apiKey && bearerKey && !constantTimeEqual(apiKey, bearerKey)) {
    return null
  }

  return apiKey ?? bearerKey
}

export function isAuthorizedServerRequest(
  headers: Headers,
  configuredKeys: readonly string[]
): boolean {
  const presented = presentedServerSecret(headers)
  if (!presented || configuredKeys.length === 0) {
    return false
  }

  let matched = false
  for (const configuredKey of configuredKeys) {
    matched = constantTimeEqual(presented, configuredKey) || matched
  }
  return matched
}
