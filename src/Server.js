import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, mkdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ValidateEnvironment } from './Configuration.js';
import {
  CreateWorkspace,
  CreateWorkspaceDirectory,
  DeleteWorkspacePath,
  GetWorkspaceSummary,
  ListWorkspaceFiles,
  ReadWorkspaceFile,
  RenameWorkspacePath,
  UploadWorkspaceFile,
  WorkspaceError,
  WriteWorkspaceFile,
} from './Workspace.js';

try {
  process.loadEnvFile?.();
} catch (Error) {
  if (Error.code !== 'ENOENT') throw Error;
}
if (process.env.NODE_ENV === 'production') ValidateEnvironment(process.env);

const Config = {
  AppName: process.env.APP_NAME || 'Endpoint Workspace Manager',
  Host: process.env.HOST || '0.0.0.0',
  Port: Number(process.env.PORT || process.env.SERVER_PORT || 3000),
  PublicHost: process.env.PUBLIC_HOST || 'links.example.com',
  AdminHost: process.env.ADMIN_HOST || 'manage.example.com',
  DatabasePath: resolve(process.env.DATABASE_PATH || 'data/endpoints.sqlite'),
  StaticSitesPath: resolve(process.env.STATIC_SITES_PATH || 'sites'),
  AdminAssetsPath: resolve(process.env.ADMIN_ASSETS_PATH || 'admin'),
  SessionSecret: process.env.SESSION_SECRET || '',
  OAuthProviderName: process.env.OAUTH_PROVIDER_NAME || 'OAuth',
  OAuthAuthorizeUrl: process.env.OAUTH_AUTHORIZE_URL || '',
  OAuthTokenUrl: process.env.OAUTH_TOKEN_URL || '',
  OAuthUserInfoUrl: process.env.OAUTH_USERINFO_URL || '',
  OAuthScopes: process.env.OAUTH_SCOPES || '',
  OAuthUserIdField: process.env.OAUTH_USER_ID_FIELD || 'id',
  OAuthClientId: process.env.OAUTH_CLIENT_ID || '',
  OAuthClientSecret: process.env.OAUTH_CLIENT_SECRET || '',
  OAuthAuthorizedUserId: process.env.OAUTH_AUTHORIZED_USER_ID || '',
};

const ReservedSlugs = new Set(['admin', 'oauth', 'healthz']);
const MaxBodyBytes = 1_100_000;
const MaxUploadBytes = 100 * 1024 * 1024;
const MimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webm', 'video/webm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

mkdirSync(dirname(Config.DatabasePath), { recursive: true });
const Database = new DatabaseSync(Config.DatabasePath);
Database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS endpoints (
    slug TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('redirect', 'html', 'site')),
    content TEXT NOT NULL,
    permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const EndpointSchema = Database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'endpoints'").get()?.sql || '';
if (!EndpointSchema.includes("'site'")) {
  Database.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE endpoints RENAME TO endpoints_legacy;
    CREATE TABLE endpoints (
      slug TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('redirect', 'html', 'site')),
      content TEXT NOT NULL,
      permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO endpoints (slug, kind, content, permanent, created_at, updated_at)
      SELECT slug, kind, content, permanent, created_at, updated_at FROM endpoints_legacy;
    DROP TABLE endpoints_legacy;
    COMMIT;
  `);
}
Database.exec('PRAGMA optimize;');

const ListEndpoints = Database.prepare('SELECT slug, kind, content, permanent, updated_at FROM endpoints ORDER BY slug');
const GetEndpoint = Database.prepare('SELECT slug, kind, content, permanent FROM endpoints WHERE slug = ?');
const SaveEndpoint = Database.prepare(`
  INSERT INTO endpoints (slug, kind, content, permanent)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(slug) DO UPDATE SET
    kind = excluded.kind,
    content = excluded.content,
    permanent = excluded.permanent,
    updated_at = CURRENT_TIMESTAMP
`);
const DeleteEndpoint = Database.prepare('DELETE FROM endpoints WHERE slug = ?');

function EscapeHtml(Value) {
  return String(Value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function GetHost(Request) {
  const ForwardedHost = Request.headers['x-forwarded-host'];
  return String(ForwardedHost || Request.headers.host || '').split(',')[0].trim().toLowerCase().split(':')[0];
}

function GetCookies(Request) {
  return Object.fromEntries(
    String(Request.headers.cookie || '')
      .split(';')
      .map((Part) => Part.trim().split('='))
      .filter(([Name, Value]) => Name && Value)
      .map(([Name, ...Value]) => [Name, decodeURIComponent(Value.join('='))]),
  );
}

function Sign(Value) {
  return createHmac('sha256', Config.SessionSecret).update(Value).digest('base64url');
}

function SafeEqual(Left, Right) {
  const LeftBuffer = Buffer.from(String(Left));
  const RightBuffer = Buffer.from(String(Right));
  return LeftBuffer.length === RightBuffer.length && timingSafeEqual(LeftBuffer, RightBuffer);
}

function CreateSignedValue(Payload) {
  const Encoded = Buffer.from(JSON.stringify(Payload)).toString('base64url');
  return `${Encoded}.${Sign(Encoded)}`;
}

function ReadSignedValue(Value) {
  const [Encoded, Signature] = String(Value || '').split('.');
  if (!Encoded || !Signature || !SafeEqual(Sign(Encoded), Signature)) return null;
  try {
    const Payload = JSON.parse(Buffer.from(Encoded, 'base64url').toString('utf8'));
    return Number(Payload.ExpiresAt) > Date.now() ? Payload : null;
  } catch {
    return null;
  }
}

function GetSession(Request) {
  return ReadSignedValue(GetCookies(Request).QckSession);
}

function GetCsrfToken(Session) {
  return Sign(`csrf:${Session.UserId}:${Session.ExpiresAt}`);
}

function IsValidSlug(Slug) {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(Slug) && !ReservedSlugs.has(Slug);
}

function IsValidRedirect(Target) {
  try {
    const Url = new URL(Target);
    return Url.protocol === 'https:' || Url.protocol === 'http:';
  } catch {
    return false;
  }
}

function Send(Response, Status, Body, Headers = {}) {
  Response.writeHead(Status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...Headers,
  });
  Response.end(Body);
}

function SendHtml(Response, Status, Body, Headers = {}) {
  Send(Response, Status, Body, {
    'Content-Type': 'text/html; charset=utf-8',
    ...Headers,
  });
}

function SendJson(Response, Status, Value, Headers = {}) {
  Send(Response, Status, JSON.stringify(Value), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...Headers,
  });
}

function Redirect(Response, Location, Status = 302, Headers = {}) {
  Send(Response, Status, `Redirecting to ${Location}`, { Location, ...Headers });
}

function IsInside(RootPath, CandidatePath) {
  return CandidatePath === RootPath || CandidatePath.startsWith(`${RootPath}${sep}`);
}

function SendFile(Request, Response, FilePath, ExtraHeaders = {}) {
  let FileStats;
  try {
    FileStats = statSync(FilePath);
  } catch {
    return Send(Response, 404, 'Not found.');
  }
  if (!FileStats.isFile()) return Send(Response, 404, 'Not found.');

  const ContentType = MimeTypes.get(extname(FilePath).toLowerCase()) || 'application/octet-stream';
  const Headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Content-Type': ContentType,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': `frame-ancestors 'self' https://${Config.AdminHost}`,
    ...ExtraHeaders,
  };
  let Start = 0;
  let End = FileStats.size - 1;
  let Status = 200;
  const Range = String(Request.headers.range || '');
  if (FileStats.size === 0) {
    if (Range) return Send(Response, 416, 'Invalid range.', { 'Content-Range': 'bytes */0' });
    Response.writeHead(200, { ...Headers, 'Content-Length': '0' });
    return Response.end();
  }
  if (Range) {
    const Match = /^bytes=(\d*)-(\d*)$/.exec(Range);
    if (!Match) return Send(Response, 416, 'Invalid range.', { 'Content-Range': `bytes */${FileStats.size}` });
    if (!Match[1]) {
      const SuffixLength = Number(Match[2]);
      if (!Number.isSafeInteger(SuffixLength) || SuffixLength <= 0) return Send(Response, 416, 'Invalid range.', { 'Content-Range': `bytes */${FileStats.size}` });
      Start = Math.max(0, FileStats.size - SuffixLength);
    } else {
      Start = Number(Match[1]);
      End = Match[2] ? Number(Match[2]) : End;
    }
    if (!Number.isSafeInteger(Start) || !Number.isSafeInteger(End) || Start < 0 || End < Start || Start >= FileStats.size) {
      return Send(Response, 416, 'Invalid range.', { 'Content-Range': `bytes */${FileStats.size}` });
    }
    End = Math.min(End, FileStats.size - 1);
    Status = 206;
    Headers['Content-Range'] = `bytes ${Start}-${End}/${FileStats.size}`;
  }
  Headers['Content-Length'] = String(End - Start + 1);
  Response.writeHead(Status, Headers);
  if (Request.method === 'HEAD') return Response.end();
  const Stream = createReadStream(FilePath, { start: Start, end: End });
  Stream.on('error', () => Response.destroy());
  Stream.pipe(Response);
}

function ServeStaticSite(Request, Response, Url, Endpoint, Slug, PathParts) {
  if (!PathParts.length && !Url.pathname.endsWith('/')) return Redirect(Response, `${Url.pathname}/${Url.search}`, 308);
  if (PathParts.some((Part) => !Part || Part === '.' || Part === '..' || (Part.startsWith('.') && Part !== '.well-known'))) return Send(Response, 404, 'Not found.');
  const SitesRoot = Config.StaticSitesPath;
  const SiteRoot = resolve(SitesRoot, Endpoint.content);
  if (!IsInside(SitesRoot, SiteRoot)) return Send(Response, 404, 'Not found.');
  let FilePath = resolve(SiteRoot, ...(PathParts.length ? PathParts : ['index.html']));
  if (!IsInside(SiteRoot, FilePath)) return Send(Response, 404, 'Not found.');
  try {
    if (statSync(FilePath).isDirectory()) FilePath = resolve(FilePath, 'index.html');
    const RealSiteRoot = realpathSync(SiteRoot);
    const RealFilePath = realpathSync(FilePath);
    if (!IsInside(RealSiteRoot, RealFilePath)) return Send(Response, 404, 'Not found.');
    FilePath = RealFilePath;
  } catch {
    return Send(Response, 404, 'Not found.');
  }
  return SendFile(Request, Response, FilePath);
}

async function ReadBody(Request, Limit = MaxBodyBytes) {
  let Size = 0;
  const Chunks = [];
  for await (const Chunk of Request) {
    Size += Chunk.length;
    if (Size > Limit) throw new WorkspaceError(413, 'Request body is too large.');
    Chunks.push(Chunk);
  }
  return Buffer.concat(Chunks);
}

async function ReadForm(Request) {
  return new URLSearchParams((await ReadBody(Request)).toString('utf8'));
}

function GetNestedValue(Value, Path) {
  return Path.split('.').reduce((Current, Key) => Current?.[Key], Value);
}

function GetOAuthConfigurationError() {
  if (Config.SessionSecret.length < 32) return 'SESSION_SECRET must contain at least 32 characters.';
  const Required = [Config.OAuthAuthorizeUrl, Config.OAuthTokenUrl, Config.OAuthUserInfoUrl, Config.OAuthClientId, Config.OAuthClientSecret, Config.OAuthAuthorizedUserId];
  return Required.every(Boolean) ? null : 'OAuth has not been configured yet.';
}

function RenderLayout(Title, Content) {
  const AssetVersion = Math.max(
    statSync(resolve(Config.AdminAssetsPath, 'Admin.css')).mtimeMs,
    statSync(resolve(Config.AdminAssetsPath, 'Admin.js')).mtimeMs,
  ).toString(36);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${EscapeHtml(Title)} · ${EscapeHtml(Config.AppName)}</title><link rel="stylesheet" href="/assets/Admin.css?v=${AssetVersion}"><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090b10;color:#f4f7f6}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,rgba(46,190,145,.13),transparent 32rem),#090b10}main{width:min(1100px,92vw);margin:0 auto;padding:3rem 0 5rem}header{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:2.5rem}.brand{font-weight:800;letter-spacing:-.04em;font-size:1.35rem}.muted{color:#899790}h1{font-size:clamp(2rem,5vw,3.6rem);letter-spacing:-.055em;margin:.2rem 0 1rem}p{line-height:1.6}a{color:#75e5bd}button,.button{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid #397a64;border-radius:.65rem;padding:.7rem 1rem;background:#13271f;color:#eafff7;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}button:hover,.button:hover{background:#18372b}.secondary{border-color:#303a36;background:#151a18}.danger{border-color:#7d3e48;background:#2a1519}.grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:1.2rem}.card{border:1px solid #222b27;border-radius:1rem;background:rgba(16,20,19,.88);padding:1.3rem}.endpoint{display:flex;justify-content:space-between;gap:1rem;padding:1rem 0;border-bottom:1px solid #222b27}.endpoint:last-child{border:0}.slug{font-weight:800;font-size:1.08rem}.tag{display:inline-block;padding:.2rem .5rem;border-radius:999px;background:#18251f;color:#91d9bd;font-size:.75rem;text-transform:uppercase;letter-spacing:.08em}label{display:block;color:#aebbb5;font-size:.88rem;font-weight:700;margin:1rem 0 .45rem}input,select,textarea{width:100%;border:1px solid #303a36;border-radius:.6rem;background:#0c100f;color:#f4f7f6;padding:.75rem;font:inherit}textarea{min-height:240px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.88rem;line-height:1.5;resize:vertical}.actions{display:flex;flex-wrap:wrap;gap:.65rem;margin-top:1rem}.notice{padding:.85rem 1rem;border:1px solid #66562d;border-radius:.65rem;background:#241f12;color:#f3dda0}.empty{padding:2.2rem 0;color:#74817b}.check{display:flex;align-items:center;gap:.6rem}.check input{width:auto}@media(max-width:800px){main{padding-top:1.5rem}.grid{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}}
</style></head><body><main>${Content}</main><script src="/assets/Admin.js?v=${AssetVersion}" defer></script></body></html>`;
}

function RenderAdmin(Session, Message = '', SelectedSlug = '') {
  const Endpoints = ListEndpoints.all();
  const Selected = SelectedSlug ? GetEndpoint.get(SelectedSlug) : null;
  const Rows = Endpoints.length
    ? Endpoints.map((Endpoint) => {
      const Description = Endpoint.kind === 'redirect' ? Endpoint.content : Endpoint.kind === 'site' ? 'Static site directory' : 'HTML document';
      const EditAction = Endpoint.kind === 'site' ? '' : `<a class="button secondary" href="/?edit=${encodeURIComponent(Endpoint.slug)}">Edit</a>`;
      const ManageAction = Endpoint.kind === 'site' ? `<a class="button" href="/workspace/${encodeURIComponent(Endpoint.slug)}">Workspace</a>` : '';
      return `<div class="endpoint"><div><div class="slug">/${EscapeHtml(Endpoint.slug)}</div><div class="muted">${EscapeHtml(Description)}</div></div><div class="actions"><span class="tag">${EscapeHtml(Endpoint.kind)}</span>${ManageAction}${EditAction}<a class="button secondary" href="https://${EscapeHtml(Config.PublicHost)}/${encodeURIComponent(Endpoint.slug)}/" target="_blank" rel="noopener">Open</a></div></div>`;
    }).join('')
    : '<div class="empty">No endpoints yet.</div>';
  const CsrfToken = GetCsrfToken(Session);
  return RenderLayout(Config.AppName, `
    <header><div class="brand">${EscapeHtml(Config.PublicHost)} / endpoints</div><a class="button secondary" href="/logout">Sign out</a></header>
    <h1>${EscapeHtml(Config.AppName)}</h1><p class="muted">Create a short redirect, serve a complete HTML document, or host a managed static site at any available slug.</p>
    ${Message ? `<p class="notice">${EscapeHtml(Message)}</p>` : ''}
    <section class="card workspace-create"><div><p class="section-label">Static workspaces</p><h2>Start a directory-backed site</h2><p class="muted">Creates an editable <code>index.html</code> and stylesheet, ready to publish at the selected slug.</p></div><form method="post" action="/workspace/create"><input type="hidden" name="csrf" value="${EscapeHtml(CsrfToken)}"><label for="workspace-slug">Workspace slug</label><div class="inline-form"><input id="workspace-slug" name="slug" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" placeholder="new-site"><button type="submit">Create workspace</button></div></form></section>
    <div class="grid"><section class="card"><h2>Published</h2>${Rows}</section>
    <section class="card"><h2>Create or update</h2><form method="post" action="/endpoint/save">
      <input type="hidden" name="csrf" value="${EscapeHtml(CsrfToken)}">
      <label for="slug">Slug</label><input id="slug" name="slug" required maxlength="64" pattern="[a-z0-9][a-z0-9_-]{0,63}" placeholder="portfolio" value="${EscapeHtml(Selected?.slug || '')}">
      <label for="kind">Type</label><select id="kind" name="kind"><option value="redirect"${Selected?.kind === 'redirect' ? ' selected' : ''}>Redirect</option><option value="html"${Selected?.kind === 'html' ? ' selected' : ''}>HTML document</option></select>
      <label for="content">Destination URL or HTML</label><textarea id="content" name="content" required placeholder="https://example.com or <!doctype html>…">${EscapeHtml(Selected?.content || '')}</textarea>
      <label class="check"><input type="checkbox" name="permanent" value="1"${Selected?.permanent ? ' checked' : ''}> Permanent redirect (301)</label>
      <div class="actions"><button type="submit">Save endpoint</button>${Selected ? '<a class="button secondary" href="/">Cancel edit</a>' : ''}</div>
    </form><form method="post" action="/endpoint/delete"><input type="hidden" name="csrf" value="${EscapeHtml(CsrfToken)}"><label for="delete-slug">Delete a slug</label><input id="delete-slug" name="slug" required placeholder="portfolio"><div class="actions"><button class="danger" type="submit">Delete endpoint</button></div></form></section></div>
  `);
}

function RenderWorkspace(Session, Endpoint) {
  const Slug = Endpoint.slug;
  const Summary = GetWorkspaceSummary(Config.StaticSitesPath, Slug);
  const CsrfToken = GetCsrfToken(Session);
  return RenderLayout(`/${Slug} workspace`, `
    <div id="WorkspaceApp" data-workspace="${EscapeHtml(Slug)}" data-csrf="${EscapeHtml(CsrfToken)}" data-public-url="https://${EscapeHtml(Config.PublicHost)}/${encodeURIComponent(Slug)}/">
      <header><div><a class="brand" href="/">${EscapeHtml(Config.PublicHost)} / endpoints</a><span class="breadcrumb"> / ${EscapeHtml(Slug)}</span></div><div class="actions"><a class="button secondary" href="https://${EscapeHtml(Config.PublicHost)}/${encodeURIComponent(Slug)}/" target="_blank" rel="noopener">Open live site</a><a class="button secondary" href="/logout">Sign out</a></div></header>
      <section class="workspace-hero"><div><p class="section-label">Static workspace</p><h1>/${EscapeHtml(Slug)}</h1><p class="muted"><span id="WorkspaceFileCount">${Summary.Files}</span> files · <span id="WorkspaceByteCount">${Summary.Bytes}</span> bytes · changes publish immediately</p></div><div class="workspace-actions"><button type="button" data-workspace-action="new-file">New file</button><button type="button" class="secondary" data-workspace-action="new-folder">New folder</button><label class="button secondary upload-button">Upload files<input id="WorkspaceUpload" type="file" multiple hidden></label><label class="button secondary upload-button">Upload folder<input id="WorkspaceFolderUpload" type="file" webkitdirectory multiple hidden></label></div></section>
      <div id="WorkspaceNotice" class="workspace-notice" role="status" aria-live="polite"></div>
      <section class="workspace-shell">
        <aside class="file-browser card"><div class="panel-heading"><div><p class="section-label">Explorer</p><h2>Files</h2></div><button type="button" class="icon-button" data-workspace-action="refresh" title="Refresh files" aria-label="Refresh files">↻</button></div><div id="WorkspaceTree" class="file-tree" aria-label="Workspace files"></div></aside>
        <section class="editor-panel card">
          <div class="editor-toolbar"><div><p class="section-label">Editor</p><strong id="EditorPath">Select a text file</strong></div><div class="actions"><button id="FindToggle" type="button" class="secondary" disabled>Find</button><button id="RenameFile" type="button" class="secondary" disabled>Rename</button><button id="DeleteFile" type="button" class="danger" disabled>Delete</button><button id="SaveFile" type="button" disabled>Save</button></div></div>
          <div id="FindBar" class="find-bar" hidden><input id="FindText" placeholder="Find"><input id="ReplaceText" placeholder="Replace"><button id="FindNext" type="button" class="secondary">Next</button><button id="ReplaceOne" type="button" class="secondary">Replace</button><button id="ReplaceAll" type="button" class="secondary">All</button></div>
          <div class="editor-wrap"><pre id="LineNumbers" class="line-numbers" aria-hidden="true">1</pre><textarea id="CodeEditor" class="code-editor" spellcheck="false" wrap="off" disabled aria-label="File editor"></textarea></div>
          <footer class="editor-status"><span id="EditorState">No file selected</span><span><span id="EditorMode">TEXT</span> · Ln <span id="EditorLine">1</span>, Col <span id="EditorColumn">1</span></span></footer>
        </section>
        <aside class="preview-panel card"><div class="panel-heading"><div><p class="section-label">Preview</p><h2>Live site</h2></div><button id="ReloadPreview" type="button" class="icon-button" title="Reload preview" aria-label="Reload preview">↻</button></div><iframe id="WorkspacePreview" title="Live workspace preview" src="https://${EscapeHtml(Config.PublicHost)}/${encodeURIComponent(Slug)}/"></iframe></aside>
      </section>
    </div>
  `);
}

async function HandleOAuthStart(Response) {
  const ErrorMessage = GetOAuthConfigurationError();
  if (ErrorMessage) return SendHtml(Response, 503, RenderLayout('Setup required', `<h1>Setup required</h1><p class="notice">${EscapeHtml(ErrorMessage)}</p>`));
  const Nonce = randomBytes(24).toString('base64url');
  const State = CreateSignedValue({ Nonce, ExpiresAt: Date.now() + 10 * 60_000 });
  const AuthorizeUrl = new URL(Config.OAuthAuthorizeUrl);
  AuthorizeUrl.searchParams.set('client_id', Config.OAuthClientId);
  AuthorizeUrl.searchParams.set('redirect_uri', `https://${Config.AdminHost}/oauth/callback`);
  AuthorizeUrl.searchParams.set('response_type', 'code');
  AuthorizeUrl.searchParams.set('scope', Config.OAuthScopes);
  AuthorizeUrl.searchParams.set('state', Nonce);
  Redirect(Response, AuthorizeUrl.toString(), 302, { 'Set-Cookie': `QckOAuth=${encodeURIComponent(State)}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600` });
}

async function HandleOAuthCallback(Request, Response, Url) {
  const StoredState = ReadSignedValue(GetCookies(Request).QckOAuth);
  if (!StoredState || !SafeEqual(StoredState.Nonce, Url.searchParams.get('state') || '')) return Send(Response, 400, 'Invalid OAuth state.');
  const Code = Url.searchParams.get('code');
  if (!Code) return Send(Response, 400, 'OAuth did not return an authorization code.');
  const TokenResponse = await fetch(Config.OAuthTokenUrl, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: Config.OAuthClientId, client_secret: Config.OAuthClientSecret, grant_type: 'authorization_code', code: Code, redirect_uri: `https://${Config.AdminHost}/oauth/callback` }),
  });
  if (!TokenResponse.ok) return Send(Response, 502, 'OAuth token exchange failed.');
  const Token = await TokenResponse.json();
  const UserResponse = await fetch(Config.OAuthUserInfoUrl, { headers: { Accept: 'application/json', Authorization: `Bearer ${Token.access_token}` } });
  if (!UserResponse.ok) return Send(Response, 502, 'OAuth identity lookup failed.');
  const User = await UserResponse.json();
  const UserId = String(GetNestedValue(User, Config.OAuthUserIdField) ?? '');
  if (!UserId || !SafeEqual(UserId, Config.OAuthAuthorizedUserId)) return Send(Response, 403, 'This account is not authorized.');
  const Session = CreateSignedValue({ UserId, ExpiresAt: Date.now() + 12 * 60 * 60_000 });
  Redirect(Response, '/', 302, { 'Set-Cookie': [`QckSession=${encodeURIComponent(Session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`, 'QckOAuth=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0'] });
}

function GetStaticEndpoint(Slug) {
  const Endpoint = GetEndpoint.get(Slug);
  if (!Endpoint || Endpoint.kind !== 'site') throw new WorkspaceError(404, 'Static workspace not found.');
  return Endpoint;
}

function IsValidApiCsrf(Request, Session) {
  return SafeEqual(String(Request.headers['x-csrf-token'] || ''), GetCsrfToken(Session));
}

async function HandleWorkspaceApi(Request, Response, Url, Session) {
  const Match = /^\/api\/workspaces\/([a-z0-9][a-z0-9_-]{0,63})\/(files|file|upload|directory|rename|path)$/.exec(Url.pathname);
  if (!Match) return false;
  const [, Slug, Action] = Match;
  try {
    GetStaticEndpoint(Slug);
    if (Request.method === 'GET' && Action === 'files') {
      return SendJson(Response, 200, { Files: ListWorkspaceFiles(Config.StaticSitesPath, Slug), Summary: GetWorkspaceSummary(Config.StaticSitesPath, Slug) });
    }
    if (Request.method === 'GET' && Action === 'file') {
      return SendJson(Response, 200, ReadWorkspaceFile(Config.StaticSitesPath, Slug, Url.searchParams.get('path') || ''));
    }
    if (!IsValidApiCsrf(Request, Session)) return SendJson(Response, 403, { Error: 'Invalid request token.' });
    if (Request.method === 'PUT' && Action === 'file') {
      const Content = (await ReadBody(Request, 2 * 1024 * 1024)).toString('utf8');
      const Result = WriteWorkspaceFile(Config.StaticSitesPath, Slug, Url.searchParams.get('path') || '', Content, String(Request.headers['if-match'] || ''));
      return SendJson(Response, 200, Result);
    }
    if (Request.method === 'POST' && Action === 'upload') {
      const Result = UploadWorkspaceFile(Config.StaticSitesPath, Slug, Url.searchParams.get('path') || '', await ReadBody(Request, MaxUploadBytes));
      return SendJson(Response, 201, Result);
    }
    if (Request.method === 'POST' && Action === 'directory') {
      const Form = await ReadForm(Request);
      return SendJson(Response, 201, CreateWorkspaceDirectory(Config.StaticSitesPath, Slug, Form.get('path') || ''));
    }
    if (Request.method === 'POST' && Action === 'rename') {
      const Form = await ReadForm(Request);
      return SendJson(Response, 200, RenameWorkspacePath(Config.StaticSitesPath, Slug, Form.get('path') || '', Form.get('destination') || ''));
    }
    if (Request.method === 'DELETE' && Action === 'path') {
      return SendJson(Response, 200, DeleteWorkspacePath(Config.StaticSitesPath, Slug, Url.searchParams.get('path') || ''));
    }
    return SendJson(Response, 405, { Error: 'Method not allowed.' }, { Allow: 'GET, PUT, POST, DELETE' });
  } catch (Error) {
    if (Error instanceof WorkspaceError) return SendJson(Response, Error.Status, { Error: Error.message });
    throw Error;
  }
}

async function HandleAdmin(Request, Response, Url) {
  if (Url.pathname === '/healthz') return Send(Response, 200, 'ok');
  if (Request.method === 'GET' && Url.pathname === '/assets/Admin.css') return SendFile(Request, Response, resolve(Config.AdminAssetsPath, 'Admin.css'), { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' });
  if (Request.method === 'GET' && Url.pathname === '/assets/Admin.js') return SendFile(Request, Response, resolve(Config.AdminAssetsPath, 'Admin.js'), { 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache' });
  if (Url.pathname === '/oauth/login') return HandleOAuthStart(Response);
  if (Url.pathname === '/oauth/callback') return HandleOAuthCallback(Request, Response, Url);
  if (Url.pathname === '/logout') return Redirect(Response, '/', 302, { 'Set-Cookie': 'QckSession=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  const Session = GetSession(Request);
  if (!Session) return SendHtml(Response, 401, RenderLayout('Sign in', `<header><div class="brand">${EscapeHtml(Config.PublicHost)} / endpoints</div></header><h1>Management access</h1><p class="muted">Only the authorized account can manage public endpoints.</p><a class="button" href="/oauth/login">Continue with ${EscapeHtml(Config.OAuthProviderName)}</a>`));
  if (Request.method === 'GET' && Url.pathname === '/') return SendHtml(Response, 200, RenderAdmin(Session, '', Url.searchParams.get('edit') || ''));
  const WorkspaceMatch = /^\/workspace\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(Url.pathname);
  if (Request.method === 'GET' && WorkspaceMatch) {
    try {
      return SendHtml(Response, 200, RenderWorkspace(Session, GetStaticEndpoint(WorkspaceMatch[1])));
    } catch (Error) {
      if (Error instanceof WorkspaceError) return SendHtml(Response, Error.Status, RenderAdmin(Session, Error.message));
      throw Error;
    }
  }
  if (Url.pathname.startsWith('/api/workspaces/')) {
    const Handled = await HandleWorkspaceApi(Request, Response, Url, Session);
    if (Handled !== false) return Handled;
  }
  if (Request.method === 'POST' && Url.pathname === '/workspace/create') {
    try {
      const Form = await ReadForm(Request);
      if (!SafeEqual(Form.get('csrf') || '', GetCsrfToken(Session))) return Send(Response, 403, 'Invalid request token.');
      const Slug = String(Form.get('slug') || '').toLowerCase();
      if (!IsValidSlug(Slug)) return SendHtml(Response, 400, RenderAdmin(Session, 'Use 1–64 lowercase letters, numbers, underscores, or hyphens.'));
      if (GetEndpoint.get(Slug)) return SendHtml(Response, 409, RenderAdmin(Session, 'An endpoint already uses that slug.'));
      CreateWorkspace(Config.StaticSitesPath, Slug, Config.PublicHost);
      SaveEndpoint.run(Slug, 'site', Slug, 0);
      return Redirect(Response, `/workspace/${encodeURIComponent(Slug)}`);
    } catch (Error) {
      if (Error instanceof WorkspaceError) return SendHtml(Response, Error.Status, RenderAdmin(Session, Error.message));
      throw Error;
    }
  }
  if (Request.method === 'POST' && Url.pathname === '/endpoint/save') {
    try {
      const Form = await ReadForm(Request);
      if (!SafeEqual(Form.get('csrf') || '', GetCsrfToken(Session))) return Send(Response, 403, 'Invalid request token.');
      const Slug = String(Form.get('slug') || '').toLowerCase();
      const Kind = String(Form.get('kind') || '');
      const Content = String(Form.get('content') || '');
      if (!IsValidSlug(Slug)) return SendHtml(Response, 400, RenderAdmin(Session, 'Use 1–64 lowercase letters, numbers, underscores, or hyphens.'));
      if (!['redirect', 'html'].includes(Kind)) return Send(Response, 400, 'Invalid endpoint type.');
      if (!Content || Content.length > 1_000_000) return SendHtml(Response, 400, RenderAdmin(Session, 'Content must be between 1 byte and 1 MB.'));
      if (Kind === 'redirect' && !IsValidRedirect(Content)) return SendHtml(Response, 400, RenderAdmin(Session, 'Redirects must use a valid HTTP or HTTPS URL.'));
      SaveEndpoint.run(Slug, Kind, Content, Form.get('permanent') === '1' ? 1 : 0);
      return Redirect(Response, '/');
    } catch (Error) {
      return SendHtml(Response, 400, RenderAdmin(Session, Error.message));
    }
  }
  if (Request.method === 'POST' && Url.pathname === '/endpoint/delete') {
    const Form = await ReadForm(Request);
    if (!SafeEqual(Form.get('csrf') || '', GetCsrfToken(Session))) return Send(Response, 403, 'Invalid request token.');
    DeleteEndpoint.run(String(Form.get('slug') || '').toLowerCase());
    return Redirect(Response, '/');
  }
  return Send(Response, 404, 'Not found.');
}

function HandlePublic(Request, Response, Url) {
  if (Url.pathname === '/healthz') return Send(Response, 200, 'ok');
  let PathParts;
  try {
    PathParts = Url.pathname.split('/').filter(Boolean).map((Part) => decodeURIComponent(Part));
  } catch {
    return Send(Response, 404, 'Not found.');
  }
  const Slug = String(PathParts.shift() || '').toLowerCase();
  if (!IsValidSlug(Slug)) return Send(Response, 404, 'Not found.');
  const Endpoint = GetEndpoint.get(Slug);
  if (!Endpoint) return Send(Response, 404, 'Not found.');
  if (Endpoint.kind === 'site') return ServeStaticSite(Request, Response, Url, Endpoint, Slug, PathParts);
  if (PathParts.length) return Send(Response, 404, 'Not found.');
  if (Endpoint.kind === 'redirect') return Redirect(Response, Endpoint.content, Endpoint.permanent ? 301 : 302, { 'Cache-Control': 'no-store' });
  return SendHtml(Response, 200, Endpoint.content, { 'Cache-Control': 'no-cache', 'Content-Security-Policy': `frame-ancestors 'self' https://${Config.AdminHost}` });
}

const Server = createServer(async (Request, Response) => {
  try {
    const Host = GetHost(Request);
    const Url = new URL(Request.url || '/', `https://${Host || 'localhost'}`);
    if (Host === Config.AdminHost) return await HandleAdmin(Request, Response, Url);
    if (Host === Config.PublicHost) return HandlePublic(Request, Response, Url);
    if (Url.pathname === '/healthz') return Send(Response, 200, 'ok');
    return Send(Response, 421, 'Unknown host.');
  } catch (Error) {
    console.error('[EndpointManager:Server]', Error);
    return Send(Response, 500, 'Internal server error.');
  }
});

Server.listen(Config.Port, Config.Host, () => {
  console.log(`[EndpointManager:Server] Listening on ${Config.Host}:${Config.Port}`);
});
