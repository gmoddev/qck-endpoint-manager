import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';

const MaxEditableBytes = 2 * 1024 * 1024;
const MaxWorkspaceEntries = 5_000;
const TextExtensions = new Set([
  '', '.css', '.csv', '.htm', '.html', '.ini', '.js', '.json', '.jsx', '.md', '.mjs', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

export class WorkspaceError extends Error {
  constructor(Status, Message) {
    super(Message);
    this.name = 'WorkspaceError';
    this.Status = Status;
  }
}

function IsInside(RootPath, CandidatePath) {
  return CandidatePath === RootPath || CandidatePath.startsWith(`${RootPath}${sep}`);
}

function ValidateSlug(Slug) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(Slug)) throw new WorkspaceError(400, 'Invalid workspace slug.');
}

function GetParts(RelativePath, AllowRoot = false) {
  const Normalized = String(RelativePath || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  if (!Normalized) {
    if (AllowRoot) return [];
    throw new WorkspaceError(400, 'A file or directory path is required.');
  }
  const Parts = Normalized.split('/');
  if (Parts.some((Part) => !Part || Part === '.' || Part === '..' || Part.includes('\0') || (Part.startsWith('.') && Part !== '.well-known'))) {
    throw new WorkspaceError(400, 'The path contains a reserved segment.');
  }
  return Parts;
}

export function GetWorkspaceRoot(SitesPath, Slug) {
  ValidateSlug(Slug);
  const RootPath = resolve(SitesPath);
  const WorkspacePath = resolve(RootPath, Slug);
  if (!IsInside(RootPath, WorkspacePath)) throw new WorkspaceError(400, 'Invalid workspace path.');
  return WorkspacePath;
}

function GetWorkspacePath(SitesPath, Slug, RelativePath, AllowRoot = false) {
  const WorkspacePath = GetWorkspaceRoot(SitesPath, Slug);
  const Parts = GetParts(RelativePath, AllowRoot);
  const CandidatePath = resolve(WorkspacePath, ...Parts);
  if (!IsInside(WorkspacePath, CandidatePath)) throw new WorkspaceError(400, 'Invalid workspace path.');
  if (existsSync(WorkspacePath)) {
    const RealWorkspacePath = realpathSync(WorkspacePath);
    let ExistingPath = CandidatePath;
    while (!existsSync(ExistingPath) && ExistingPath !== WorkspacePath) ExistingPath = dirname(ExistingPath);
    if (!IsInside(RealWorkspacePath, realpathSync(ExistingPath))) throw new WorkspaceError(400, 'The path crosses a symbolic-link boundary.');
    if (existsSync(CandidatePath) && lstatSync(CandidatePath).isSymbolicLink()) throw new WorkspaceError(400, 'Symbolic links cannot be managed.');
  }
  return { WorkspacePath, CandidatePath, RelativePath: Parts.join('/') };
}

export function IsEditableFile(FilePath) {
  return TextExtensions.has(extname(FilePath).toLowerCase());
}

function GetRevision(Content) {
  return createHash('sha256').update(Content).digest('base64url');
}

function GetSnapshotPath(WorkspacePath, RelativePath) {
  const Stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const SnapshotRoot = resolve(WorkspacePath, '.history', `${Stamp}-${randomBytes(3).toString('hex')}`);
  const SnapshotPath = resolve(SnapshotRoot, RelativePath);
  if (!IsInside(SnapshotRoot, SnapshotPath)) throw new WorkspaceError(400, 'Invalid snapshot path.');
  mkdirSync(dirname(SnapshotPath), { recursive: true });
  return SnapshotPath;
}

function SnapshotPath(WorkspacePath, CandidatePath, RelativePath) {
  if (!existsSync(CandidatePath)) return;
  const SnapshotPath = GetSnapshotPath(WorkspacePath, RelativePath);
  const Stats = statSync(CandidatePath);
  if (Stats.isDirectory()) cpSync(CandidatePath, SnapshotPath, { recursive: true, errorOnExist: true });
  else copyFileSync(CandidatePath, SnapshotPath);
}

export function CreateWorkspace(SitesPath, Slug, PublicHost = 'links.example.com') {
  const WorkspacePath = GetWorkspaceRoot(SitesPath, Slug);
  if (existsSync(WorkspacePath)) throw new WorkspaceError(409, 'A workspace with this slug already exists.');
  mkdirSync(WorkspacePath, { recursive: true });
  writeFileSync(resolve(WorkspacePath, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>/${Slug}</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <main>
    <p class="eyebrow">${PublicHost}/${Slug}</p>
    <h1>Your static workspace is ready.</h1>
    <p>Edit <code>index.html</code> from the endpoint manager to begin.</p>
  </main>
</body>
</html>
`);
  writeFileSync(resolve(WorkspacePath, 'styles.css'), `:root { color-scheme: dark; font-family: system-ui, sans-serif; background: #080b0f; color: #f5f7f8; }
body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
main { width: min(680px, 88vw); }
.eyebrow { color: #72e3b7; text-transform: uppercase; letter-spacing: .14em; }
h1 { font-size: clamp(2.4rem, 8vw, 5rem); line-height: .95; letter-spacing: -.06em; }
code { color: #72e3b7; }
`);
  return WorkspacePath;
}

export function ListWorkspaceFiles(SitesPath, Slug) {
  const WorkspacePath = GetWorkspaceRoot(SitesPath, Slug);
  if (!existsSync(WorkspacePath) || !statSync(WorkspacePath).isDirectory()) throw new WorkspaceError(404, 'Workspace not found.');
  const Entries = [];
  function Visit(CurrentPath) {
    for (const Entry of readdirSync(CurrentPath, { withFileTypes: true }).sort((Left, Right) => Number(Right.isDirectory()) - Number(Left.isDirectory()) || Left.name.localeCompare(Right.name))) {
      if (Entry.name === '.history' || Entry.isSymbolicLink()) continue;
      const EntryPath = resolve(CurrentPath, Entry.name);
      if (!IsInside(WorkspacePath, EntryPath)) continue;
      const RelativePath = relative(WorkspacePath, EntryPath).split(sep).join('/');
      const Stats = statSync(EntryPath);
      Entries.push({
        Path: RelativePath,
        Name: Entry.name,
        Type: Entry.isDirectory() ? 'directory' : 'file',
        Size: Entry.isFile() ? Stats.size : null,
        ModifiedAt: Stats.mtime.toISOString(),
        Editable: Entry.isFile() && Stats.size <= MaxEditableBytes && IsEditableFile(Entry.name),
      });
      if (Entries.length > MaxWorkspaceEntries) throw new WorkspaceError(413, 'Workspace contains too many entries.');
      if (Entry.isDirectory()) Visit(EntryPath);
    }
  }
  Visit(WorkspacePath);
  return Entries;
}

export function ReadWorkspaceFile(SitesPath, Slug, RelativePath) {
  const { CandidatePath } = GetWorkspacePath(SitesPath, Slug, RelativePath);
  let Stats;
  try {
    Stats = statSync(CandidatePath);
  } catch {
    throw new WorkspaceError(404, 'File not found.');
  }
  if (!Stats.isFile()) throw new WorkspaceError(400, 'The selected path is not a file.');
  if (!IsEditableFile(CandidatePath)) throw new WorkspaceError(415, 'This file is binary and cannot be edited as text.');
  if (Stats.size > MaxEditableBytes) throw new WorkspaceError(413, 'This text file is too large for the editor.');
  const Content = readFileSync(CandidatePath);
  return { Content: Content.toString('utf8'), Revision: GetRevision(Content), Size: Stats.size, ModifiedAt: Stats.mtime.toISOString() };
}

export function WriteWorkspaceFile(SitesPath, Slug, RelativePath, Content, ExpectedRevision = '') {
  const { WorkspacePath, CandidatePath, RelativePath: SafeRelativePath } = GetWorkspacePath(SitesPath, Slug, RelativePath);
  if (!IsEditableFile(CandidatePath)) throw new WorkspaceError(415, 'This file type cannot be edited as text.');
  const ContentBuffer = Buffer.from(Content);
  if (ContentBuffer.length > MaxEditableBytes) throw new WorkspaceError(413, 'Text files are limited to 2 MiB.');
  if (existsSync(CandidatePath)) {
    if (!statSync(CandidatePath).isFile()) throw new WorkspaceError(400, 'The selected path is not a file.');
    const CurrentContent = readFileSync(CandidatePath);
    if (ExpectedRevision && ExpectedRevision !== GetRevision(CurrentContent)) throw new WorkspaceError(409, 'This file changed after you opened it. Reload before saving.');
    SnapshotPath(WorkspacePath, CandidatePath, SafeRelativePath);
  }
  mkdirSync(dirname(CandidatePath), { recursive: true });
  writeFileSync(CandidatePath, ContentBuffer);
  return ReadWorkspaceFile(SitesPath, Slug, SafeRelativePath);
}

export function UploadWorkspaceFile(SitesPath, Slug, RelativePath, Content) {
  const { WorkspacePath, CandidatePath, RelativePath: SafeRelativePath } = GetWorkspacePath(SitesPath, Slug, RelativePath);
  if (existsSync(CandidatePath)) {
    if (!statSync(CandidatePath).isFile()) throw new WorkspaceError(400, 'The selected path is not a file.');
    SnapshotPath(WorkspacePath, CandidatePath, SafeRelativePath);
  }
  mkdirSync(dirname(CandidatePath), { recursive: true });
  writeFileSync(CandidatePath, Content);
  return { Path: SafeRelativePath, Size: Content.length, Editable: IsEditableFile(CandidatePath) && Content.length <= MaxEditableBytes };
}

export function CreateWorkspaceDirectory(SitesPath, Slug, RelativePath) {
  const { CandidatePath, RelativePath: SafeRelativePath } = GetWorkspacePath(SitesPath, Slug, RelativePath);
  if (existsSync(CandidatePath)) throw new WorkspaceError(409, 'A file or directory already exists at that path.');
  mkdirSync(CandidatePath, { recursive: true });
  return { Path: SafeRelativePath };
}

export function RenameWorkspacePath(SitesPath, Slug, RelativePath, DestinationPath) {
  const Source = GetWorkspacePath(SitesPath, Slug, RelativePath);
  const Destination = GetWorkspacePath(SitesPath, Slug, DestinationPath);
  if (!existsSync(Source.CandidatePath)) throw new WorkspaceError(404, 'Source path not found.');
  if (existsSync(Destination.CandidatePath)) throw new WorkspaceError(409, 'The destination already exists.');
  SnapshotPath(Source.WorkspacePath, Source.CandidatePath, Source.RelativePath);
  mkdirSync(dirname(Destination.CandidatePath), { recursive: true });
  renameSync(Source.CandidatePath, Destination.CandidatePath);
  return { Path: Destination.RelativePath };
}

export function DeleteWorkspacePath(SitesPath, Slug, RelativePath) {
  const Target = GetWorkspacePath(SitesPath, Slug, RelativePath);
  if (!existsSync(Target.CandidatePath)) throw new WorkspaceError(404, 'Path not found.');
  SnapshotPath(Target.WorkspacePath, Target.CandidatePath, Target.RelativePath);
  rmSync(Target.CandidatePath, { recursive: true, force: false });
  return { Deleted: Target.RelativePath };
}

export function GetWorkspaceSummary(SitesPath, Slug) {
  const Entries = ListWorkspaceFiles(SitesPath, Slug);
  return {
    Files: Entries.filter((Entry) => Entry.Type === 'file').length,
    Directories: Entries.filter((Entry) => Entry.Type === 'directory').length,
    Bytes: Entries.reduce((Total, Entry) => Total + (Entry.Size || 0), 0),
  };
}
