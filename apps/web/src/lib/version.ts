export const APP_VERSION = __APP_VERSION__;
export const GIT_SHA = __GIT_SHA__;
export const BUILD_TIME = __BUILD_TIME__;

export interface BadgeParts {
  version: string;
  sha: string;
  schemaVersion: number | null | undefined;
  env: string;
}

/** "v0.0.1 · a1b2c3d · db 5 · staging" — the footer badge (debug step 1). */
export function formatBadge({ version, sha, schemaVersion, env }: BadgeParts): string {
  const db = schemaVersion == null ? 'db ?' : `db ${schemaVersion}`;
  return [`v${version}`, sha, db, env].join(' · ');
}
