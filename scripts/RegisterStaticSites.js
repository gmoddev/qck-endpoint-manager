import { statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

try {
  process.loadEnvFile?.();
} catch (Error) {
  if (Error.code !== 'ENOENT') throw Error;
}

const DatabasePath = resolve(process.env.DATABASE_PATH || 'data/endpoints.sqlite');
const SitesPath = resolve(process.env.STATIC_SITES_PATH || 'sites');
const Slugs = process.argv.slice(2);

if (!Slugs.length) throw new Error('Provide at least one static-site slug.');

const Database = new DatabaseSync(DatabasePath);
const SaveSite = Database.prepare(`
  INSERT INTO endpoints (slug, kind, content, permanent)
  VALUES (?, 'site', ?, 0)
  ON CONFLICT(slug) DO UPDATE SET
    kind = 'site',
    content = excluded.content,
    permanent = 0,
    updated_at = CURRENT_TIMESTAMP
`);

for (const RawSlug of Slugs) {
  const Slug = String(RawSlug).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(Slug)) throw new Error(`Invalid slug: ${RawSlug}`);
  const SitePath = resolve(SitesPath, Slug);
  if (!SitePath.startsWith(`${SitesPath}${sep}`) || !statSync(SitePath).isDirectory()) throw new Error(`Static-site directory is missing: ${Slug}`);
  SaveSite.run(Slug, Slug);
  console.log(`[EndpointManager:Workspace] Registered /${Slug}/`);
}

Database.close();
