/**
 * Generate a JPEG thumbnail from page 1 of a PDF using pdf.js.
 * Lazy-imported to keep bundle small for users who never send a PDF.
 */
export async function generatePdfThumbnail(file: File): Promise<Blob | null> {
  try {
    const pdfjs = await import('pdfjs-dist');
    // Ship the worker as a module URL. pdfjs-dist v5 exports the worker
    // path; without setting it, we'd block the main thread on parse.
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;

    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const targetW = 240;
    const scale = targetW / viewport.width;
    const v2 = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(v2.width);
    canvas.height = Math.floor(v2.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    await page.render({ canvas, canvasContext: ctx, viewport: v2 }).promise;
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.78),
    );
  } catch {
    return null;
  }
}

/** Common document MIME → user-facing label. */
export function documentLabel(mime: string | null | undefined, name: string): string {
  if (!mime) return name;
  if (mime === 'application/pdf') return 'PDF';
  if (mime.includes('word')) return 'Document Word';
  if (mime.includes('sheet') || mime.includes('excel')) return 'Tableur';
  if (mime.includes('presentation') || mime.includes('powerpoint')) return 'Présentation';
  if (mime === 'application/zip' || mime.includes('compressed')) return 'Archive';
  return name.split('.').pop()?.toUpperCase() ?? 'Fichier';
}
