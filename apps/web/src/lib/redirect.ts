/**
 * Where to go after login. Only same-origin paths are allowed ("/s/HL:LOC:…", "/places?x=1");
 * anything that could leave the app ("//evil.com", "https://…", "/\\evil") falls back to "/".
 */
export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || !target.startsWith('/')) return '/';
  if (target.startsWith('//') || target.startsWith('/\\') || /[\r\n\t]/.test(target)) return '/';
  if (target.startsWith('/login')) return '/';
  return target;
}
