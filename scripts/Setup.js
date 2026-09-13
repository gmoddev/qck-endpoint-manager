import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

function GetArguments(Values) {
  const Result = {};
  for (let Index = 0; Index < Values.length; Index += 1) {
    const Value = Values[Index];
    if (!Value.startsWith('--')) continue;
    const Key = Value.slice(2);
    if (Key === 'force') Result.Force = true;
    else Result[Key] = Values[Index += 1];
  }
  return Result;
}

function IsHostname(Value) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(Value);
}

const Arguments = GetArguments(process.argv.slice(2));
if (Arguments.help) {
  console.log('Usage: npm run setup -- --public-host links.example.org --admin-host manage.example.org --client-id 123 --authorized-user-id 456 [--app-name "Endpoint Manager"] [--force]');
  process.exit(0);
}

const PublicHost = String(Arguments['public-host'] || '').toLowerCase();
const AdminHost = String(Arguments['admin-host'] || '').toLowerCase();
const ClientId = String(Arguments['client-id'] || '');
const AuthorizedUserId = String(Arguments['authorized-user-id'] || '');
const AppName = String(Arguments['app-name'] || 'Endpoint Workspace Manager').replace(/[\r\n]/g, ' ').trim();
if (!IsHostname(PublicHost) || !IsHostname(AdminHost) || PublicHost === AdminHost) throw new Error('Provide two different valid hostnames.');
if (!/^\d+$/.test(ClientId) || !/^\d+$/.test(AuthorizedUserId)) throw new Error('Client and authorized-user IDs must contain only digits.');

const EnvironmentPath = resolve('.env');
if (existsSync(EnvironmentPath) && !Arguments.Force) throw new Error('.env already exists. Use --force only when you intend to replace it.');
const SessionSecret = randomBytes(48).toString('base64url');
const Environment = `APP_NAME=${JSON.stringify(AppName)}
PUBLIC_HOST=${PublicHost}
ADMIN_HOST=${AdminHost}
HOST=0.0.0.0
PORT=3000
DATABASE_PATH=data/endpoints.sqlite
STATIC_SITES_PATH=sites
ADMIN_ASSETS_PATH=admin
SESSION_SECRET=${SessionSecret}
OAUTH_PROVIDER_NAME=Discord
OAUTH_AUTHORIZE_URL=https://discord.com/oauth2/authorize
OAUTH_TOKEN_URL=https://discord.com/api/oauth2/token
OAUTH_USERINFO_URL=https://discord.com/api/users/@me
OAUTH_SCOPES=identify
OAUTH_USER_ID_FIELD=id
OAUTH_CLIENT_ID=${ClientId}
OAUTH_CLIENT_SECRET=replace-with-your-client-secret
OAUTH_AUTHORIZED_USER_ID=${AuthorizedUserId}
`;
writeFileSync(EnvironmentPath, Environment, { encoding: 'utf8', mode: 0o600 });
console.log('[EndpointManager:Setup] Created .env with a generated session secret.');
console.log('[EndpointManager:Setup] Add the matching OAuth client secret, then run npm run validate.');
