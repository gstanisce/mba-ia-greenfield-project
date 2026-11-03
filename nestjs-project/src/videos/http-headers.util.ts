// Quotes are escaped so a file name cannot break out of the quoted-string.
export function attachmentDisposition(fileName: string): string {
  const escaped = fileName.replace(/["\\]/g, '\\$&');
  return `attachment; filename="${escaped}"`;
}
