/** Validates a ZIP entry name and returns safe relative path components, or undefined (absolute/traversal). */
export function safeZipPath(name: string): string[] | undefined {
  const norm = name.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return undefined;
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length === 0 || parts.some((p) => p === '..' || /[\0:*?"<>|]/.test(p))) return undefined;
  return parts;
}
