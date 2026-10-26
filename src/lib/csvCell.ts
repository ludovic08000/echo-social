export function csvCell(value: unknown): string {
  const text=String(value??'');
  const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(text)?`'${text}`:text;
  return `"${safe.replace(/"/g,'""')}"`;
}
