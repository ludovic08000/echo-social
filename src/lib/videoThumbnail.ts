/**
 * Generate a thumbnail from a video file by capturing a frame at a given time.
 * Returns a Blob (JPEG) ready for upload.
 */
export function generateVideoThumbnail(
  file: File,
  timeSeconds = 1,
  maxWidth = 480,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    const url = URL.createObjectURL(file);
    video.src = url;

    const cleanup = () => URL.revokeObjectURL(url);

    video.addEventListener('loadedmetadata', () => {
      // Clamp seek time to video duration
      const seekTo = Math.min(timeSeconds, video.duration * 0.25 || 1);
      video.currentTime = seekTo;
    });

    video.addEventListener('seeked', () => {
      try {
        const canvas = document.createElement('canvas');
        const ratio = video.videoHeight / video.videoWidth;
        canvas.width = Math.min(maxWidth, video.videoWidth);
        canvas.height = Math.round(canvas.width * ratio);

        const ctx = canvas.getContext('2d');
        if (!ctx) { cleanup(); reject(new Error('Canvas not supported')); return; }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        canvas.toBlob(
          (blob) => {
            cleanup();
            if (blob) resolve(blob);
            else reject(new Error('Thumbnail generation failed'));
          },
          'image/jpeg',
          0.8,
        );
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    video.addEventListener('error', () => {
      cleanup();
      reject(new Error('Video load error'));
    });
  });
}
