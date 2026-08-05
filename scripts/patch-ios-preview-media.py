from pathlib import Path

PREVIEW_RULE = (
    "  if (/^https:\\/\\/echo-social(?:-[a-z0-9-]+)?-"
    "ludovics-projects-92893680\\.vercel\\.app$/.test(origin)) return true;\n"
)
LOVABLE_RULE = (
    "  if (/^https:\\/\\/[a-z0-9-]+\\.lovableproject\\.com$/"
    ".test(origin)) return true;\n"
)


def patch_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    if old not in text:
        raise RuntimeError(f"Missing patch anchor: {label} ({path})")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


for function_path in (
    Path("supabase/functions/r2-presign/index.ts"),
    Path("supabase/functions/r2-upload/index.ts"),
):
    patch_once(
        function_path,
        LOVABLE_RULE,
        LOVABLE_RULE + PREVIEW_RULE,
        "project-scoped Vercel CORS",
    )

r2_path = Path("src/lib/r2.ts")
patch_once(
    r2_path,
    """  // E2EE blobs always use the direct path, even when small. This avoids the
  // proxy's multipart buffering and keeps the same MIME/size policy at all sizes.
  const shouldPreferPresignedUpload =
    category === 'stories' || isEncryptedAttachment || file.size >= PRESIGN_THRESHOLD;
""",
    """  // Small encrypted chat media uses the authenticated Edge proxy. This
  // avoids browser-to-R2 CORS differences on protected Preview domains. Large
  // encrypted files still use a presigned PUT to stay below Edge body limits.
  const shouldPreferPresignedUpload =
    category === 'stories' || file.size >= PRESIGN_THRESHOLD;
""",
    "small encrypted media proxy strategy",
)

pin_path = Path("src/components/PinValidatedMessaging.tsx")
patch_once(
    pin_path,
    """  severity: 'info' | 'warning' | 'error' = 'info',
): void {
""",
    """  severity: 'info' | 'warning' | 'error' = 'info',
  failureCode?: string,
): void {
""",
    "safe enrollment failure argument",
)
patch_once(
    pin_path,
    """      platform: getCurrentPlatform(),
    },
""",
    """      platform: getCurrentPlatform(),
      ...(failureCode ? { failure_code: failureCode } : {}),
    },
""",
    "safe enrollment metadata",
)
patch_once(
    pin_path,
    """    }, { coalesce: true, cooldownMs: 2_000 }).catch(async (error) => {
      recordEnrollment(
        'E2EE_DEVICE_ENROLL_FAILED',
        classifyEnrollmentFailure(error),
        'complete',
        'error',
      );
""",
    """    }, { coalesce: true, cooldownMs: 2_000 }).catch(async (error) => {
      const failureMessage = error instanceof Error ? error.message : String(error ?? '');
      const failureCode = failureMessage
        .split(':')
        .map(part => part.trim())
        .find(part => /^[A-Z][A-Z0-9_]{2,80}$/.test(part))
        ?? 'UNKNOWN';
      recordEnrollment(
        'E2EE_DEVICE_ENROLL_FAILED',
        classifyEnrollmentFailure(error),
        'complete',
        'error',
        failureCode,
      );
""",
    "safe enrollment failure extraction",
)

print("iOS Preview media and enrollment patches applied")
