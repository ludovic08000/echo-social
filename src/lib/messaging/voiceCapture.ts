export function requestVoiceCaptureStream(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    const error = new Error('VOICE_CAPTURE_UNSUPPORTED');
    error.name = 'NotSupportedError';
    return Promise.reject(error);
  }

  // Keep the initial request inside the originating click handler. Safari,
  // installed PWAs and embedded webviews may reject a deferred permission
  // request even though the same request succeeds during the user gesture.
  return navigator.mediaDevices.getUserMedia({ audio: true });
}
