import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as CreateHttpServer, request as HttpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ValidateEnvironment } from '../src/Configuration.js';
import {
  CreateWorkspace,
  CreateWorkspaceDirectory,
  DeleteWorkspacePath,
  ListWorkspaceFiles,
  ReadWorkspaceFile,
  RenameWorkspacePath,
  UploadWorkspaceFile,
  WorkspaceError,
  WriteWorkspaceFile,
} from '../src/Workspace.js';

test('runtime supports the built-in SQLite module', async () => {
  const Sqlite = await import('node:sqlite');
  assert.equal(typeof Sqlite.DatabaseSync, 'function');
});

test('production configuration rejects placeholders and accepts complete settings', () => {
  const Environment = {
    APP_NAME: 'Endpoint Manager',
    PUBLIC_HOST: 'links.example.org',
    ADMIN_HOST: 'manage.example.org',
    SESSION_SECRET: 'a-secure-random-value-with-more-than-32-characters',
    OAUTH_PROVIDER_NAME: 'Discord',
    OAUTH_AUTHORIZE_URL: 'https://discord.com/oauth2/authorize',
    OAUTH_TOKEN_URL: 'https://discord.com/api/oauth2/token',
    OAUTH_USERINFO_URL: 'https://discord.com/api/users/@me',
    OAUTH_CLIENT_ID: '123',
    OAUTH_CLIENT_SECRET: 'secret-value',
    OAUTH_AUTHORIZED_USER_ID: '456',
  };
  assert.equal(ValidateEnvironment(Environment), true);
  assert.throws(() => ValidateEnvironment({ ...Environment, OAUTH_CLIENT_SECRET: 'replace-with-secret' }), /placeholder/);
});

test('workspace operations are confined, revision-safe, and recoverable', () => {
  const TempPath = mkdtempSync(join(tmpdir(), 'qck-workspace-'));
  try {
    CreateWorkspace(TempPath, 'sample');
    const Original = ReadWorkspaceFile(TempPath, 'sample', 'index.html');
    assert.match(Original.Content, /static workspace is ready/);

    const Saved = WriteWorkspaceFile(TempPath, 'sample', 'index.html', '<h1>Changed</h1>', Original.Revision);
    assert.notEqual(Saved.Revision, Original.Revision);
    assert.throws(
      () => WriteWorkspaceFile(TempPath, 'sample', 'index.html', '<h1>Stale</h1>', Original.Revision),
      (Error) => Error instanceof WorkspaceError && Error.Status === 409,
    );

    CreateWorkspaceDirectory(TempPath, 'sample', 'assets/icons');
    UploadWorkspaceFile(TempPath, 'sample', 'assets/icons/logo.svg', Buffer.from('<svg></svg>'));
    RenameWorkspacePath(TempPath, 'sample', 'assets/icons/logo.svg', 'assets/logo.svg');
    DeleteWorkspacePath(TempPath, 'sample', 'assets/icons');

    const Files = ListWorkspaceFiles(TempPath, 'sample');
    assert.equal(Files.some((Entry) => Entry.Path.startsWith('.history')), false);
    assert.equal(Files.some((Entry) => Entry.Path === 'assets/logo.svg'), true);
    assert.throws(() => ReadWorkspaceFile(TempPath, 'sample', '../outside.txt'), WorkspaceError);
    assert.equal(existsSync(join(TempPath, 'sample', '.history')), true);
  } finally {
    rmSync(TempPath, { recursive: true, force: true });
  }
});

function GetPort() {
  return new Promise((Resolve, Reject) => {
    const Probe = CreateHttpServer();
    Probe.once('error', Reject);
    Probe.listen(0, '127.0.0.1', () => {
      const Port = Probe.address().port;
      Probe.close((Error) => Error ? Reject(Error) : Resolve(Port));
    });
  });
}

function GetResponse(Port, Path, Headers = {}, Method = 'GET', Body = null) {
  return new Promise((Resolve, Reject) => {
    const Request = HttpRequest({ hostname: '127.0.0.1', port: Port, path: Path, method: Method, headers: { Host: 'qck.lol', ...Headers } }, (Response) => {
      const Chunks = [];
      Response.on('data', (Chunk) => Chunks.push(Chunk));
      Response.on('end', () => Resolve({ Status: Response.statusCode, Headers: Response.headers, Body: Buffer.concat(Chunks) }));
    });
    Request.once('error', Reject);
    Request.end(Body);
  });
}

test('static sites preserve subpaths and support byte ranges', async (Context) => {
  const TempPath = mkdtempSync(join(tmpdir(), 'qck-endpoint-manager-'));
  const SitesPath = join(TempPath, 'sites');
  const PortfolioPath = join(SitesPath, 'portfolio');
  mkdirSync(join(PortfolioPath, 'css'), { recursive: true });
  writeFileSync(join(PortfolioPath, 'index.html'), '<!doctype html><link rel="stylesheet" href="css/site.css">');
  writeFileSync(join(PortfolioPath, 'css', 'site.css'), 'body { color: white; }');
  writeFileSync(join(PortfolioPath, 'video.mp4'), Buffer.from([1, 2, 3, 4]));

  const DatabasePath = join(TempPath, 'endpoints.sqlite');
  const Database = new DatabaseSync(DatabasePath);
  Database.exec("CREATE TABLE endpoints (slug TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('redirect', 'html', 'site')), content TEXT NOT NULL, permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0, 1)), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO endpoints (slug, kind, content) VALUES ('portfolio', 'site', 'portfolio');");
  Database.close();

  const Port = await GetPort();
  const SessionSecret = 'integration-test-secret-at-least-32-characters';
  const Child = spawn(process.execPath, [resolve('src/Server.js')], {
    cwd: TempPath,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(Port), PUBLIC_HOST: 'qck.lol', ADMIN_HOST: 'manage.qck.lol', DATABASE_PATH: DatabasePath, STATIC_SITES_PATH: SitesPath, ADMIN_ASSETS_PATH: resolve('admin'), SESSION_SECRET: SessionSecret },
    stdio: 'ignore',
  });
  Context.after(async () => {
    if (Child.exitCode === null) {
      const Exited = new Promise((Resolve) => Child.once('exit', Resolve));
      Child.kill();
      await Exited;
    }
    rmSync(TempPath, { recursive: true, force: true });
  });

  let Health;
  for (let Attempt = 0; Attempt < 20; Attempt += 1) {
    try {
      Health = await GetResponse(Port, '/healthz');
      if (Health.Status === 200) break;
    } catch {}
    await new Promise((Resolve) => setTimeout(Resolve, 50));
  }
  assert.equal(Health?.Status, 200);

  const Root = await GetResponse(Port, '/portfolio');
  assert.equal(Root.Status, 308);
  assert.equal(Root.Headers.location, '/portfolio/');

  const Index = await GetResponse(Port, '/portfolio/');
  assert.equal(Index.Status, 200);
  assert.match(Index.Headers['content-type'], /^text\/html/);

  const Stylesheet = await GetResponse(Port, '/portfolio/css/site.css');
  assert.equal(Stylesheet.Status, 200);
  assert.match(Stylesheet.Headers['content-type'], /^text\/css/);

  const VideoRange = await GetResponse(Port, '/portfolio/video.mp4', { Range: 'bytes=1-2' });
  assert.equal(VideoRange.Status, 206);
  assert.equal(VideoRange.Headers['content-range'], 'bytes 1-2/4');
  assert.deepEqual([...VideoRange.Body], [2, 3]);

  const Session = { UserId: 'test-user', ExpiresAt: Date.now() + 60_000 };
  const EncodedSession = Buffer.from(JSON.stringify(Session)).toString('base64url');
  const Signature = createHmac('sha256', SessionSecret).update(EncodedSession).digest('base64url');
  const Cookie = `QckSession=${EncodedSession}.${Signature}`;
  const Csrf = createHmac('sha256', SessionSecret).update(`csrf:${Session.UserId}:${Session.ExpiresAt}`).digest('base64url');
  const AdminHeaders = { Host: 'manage.qck.lol', Cookie };

  const WorkspacePage = await GetResponse(Port, '/workspace/portfolio', AdminHeaders);
  assert.equal(WorkspacePage.Status, 200);
  assert.match(WorkspacePage.Body.toString('utf8'), /id="WorkspaceApp"/);

  const FilesApi = await GetResponse(Port, '/api/workspaces/portfolio/files', AdminHeaders);
  assert.equal(FilesApi.Status, 200);
  assert.equal(JSON.parse(FilesApi.Body).Summary.Files, 3);
  const MissingWorkspaceApi = await GetResponse(Port, '/api/workspaces/missing/files', AdminHeaders);
  assert.equal(MissingWorkspaceApi.Status, 404);

  const FileBeforeSave = JSON.parse((await GetResponse(Port, '/api/workspaces/portfolio/file?path=index.html', AdminHeaders)).Body);
  const SavedApi = await GetResponse(
    Port,
    '/api/workspaces/portfolio/file?path=index.html',
    { ...AdminHeaders, 'X-CSRF-Token': Csrf, 'If-Match': FileBeforeSave.Revision, 'Content-Type': 'text/plain; charset=utf-8' },
    'PUT',
    '<h1>Saved through API</h1>',
  );
  assert.equal(SavedApi.Status, 200);
  assert.match(readFileSync(join(PortfolioPath, 'index.html'), 'utf8'), /Saved through API/);
});
