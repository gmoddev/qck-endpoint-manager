const App = document.querySelector('#WorkspaceApp');

if (App) {
  const State = {
    Slug: App.dataset.workspace,
    Csrf: App.dataset.csrf,
    PublicUrl: App.dataset.publicUrl,
    Files: [],
    CurrentPath: '',
    Revision: '',
    Dirty: false,
  };

  const Elements = {
    Tree: document.querySelector('#WorkspaceTree'),
    Notice: document.querySelector('#WorkspaceNotice'),
    Editor: document.querySelector('#CodeEditor'),
    EditorPath: document.querySelector('#EditorPath'),
    EditorState: document.querySelector('#EditorState'),
    EditorMode: document.querySelector('#EditorMode'),
    EditorLine: document.querySelector('#EditorLine'),
    EditorColumn: document.querySelector('#EditorColumn'),
    LineNumbers: document.querySelector('#LineNumbers'),
    Save: document.querySelector('#SaveFile'),
    Rename: document.querySelector('#RenameFile'),
    Delete: document.querySelector('#DeleteFile'),
    FindToggle: document.querySelector('#FindToggle'),
    FindBar: document.querySelector('#FindBar'),
    FindText: document.querySelector('#FindText'),
    ReplaceText: document.querySelector('#ReplaceText'),
    Preview: document.querySelector('#WorkspacePreview'),
    Upload: document.querySelector('#WorkspaceUpload'),
    FolderUpload: document.querySelector('#WorkspaceFolderUpload'),
    FileCount: document.querySelector('#WorkspaceFileCount'),
    ByteCount: document.querySelector('#WorkspaceByteCount'),
  };

  function ShowNotice(Message, Tone = '') {
    Elements.Notice.textContent = Message;
    Elements.Notice.dataset.tone = Tone;
  }

  function FormatBytes(Bytes) {
    if (Bytes < 1024) return `${Bytes} B`;
    const Units = ['KiB', 'MiB', 'GiB'];
    let Value = Bytes / 1024;
    let Unit = Units[0];
    for (let Index = 1; Value >= 1024 && Index < Units.length; Index += 1) {
      Value /= 1024;
      Unit = Units[Index];
    }
    return `${Value.toFixed(Value >= 10 ? 0 : 1)} ${Unit}`;
  }

  async function Api(Path, Options = {}) {
    const RequestHeaders = new Headers(Options.headers || {});
    if (!['GET', 'HEAD'].includes(Options.method || 'GET')) RequestHeaders.set('X-CSRF-Token', State.Csrf);
    const Response = await fetch(Path, { ...Options, headers: RequestHeaders });
    const Payload = await Response.json().catch(() => ({ Error: `Request failed with status ${Response.status}.` }));
    if (!Response.ok) throw new Error(Payload.Error || `Request failed with status ${Response.status}.`);
    return Payload;
  }

  function GetApiPath(Action, RelativePath = '') {
    const Base = `/api/workspaces/${encodeURIComponent(State.Slug)}/${Action}`;
    return RelativePath ? `${Base}?path=${encodeURIComponent(RelativePath)}` : Base;
  }

  function GetParentPath(FilePath) {
    const Parts = FilePath.split('/');
    Parts.pop();
    return Parts.join('/');
  }

  function GetMode(FilePath) {
    const Extension = FilePath.split('.').pop().toLowerCase();
    const Modes = { css: 'CSS', htm: 'HTML', html: 'HTML', js: 'JAVASCRIPT', json: 'JSON', jsx: 'JSX', md: 'MARKDOWN', mjs: 'JAVASCRIPT', svg: 'SVG', ts: 'TYPESCRIPT', tsx: 'TSX', xml: 'XML', yaml: 'YAML', yml: 'YAML' };
    return Modes[Extension] || 'TEXT';
  }

  function UpdateCursor() {
    const BeforeCursor = Elements.Editor.value.slice(0, Elements.Editor.selectionStart);
    const Lines = BeforeCursor.split('\n');
    Elements.EditorLine.textContent = String(Lines.length);
    Elements.EditorColumn.textContent = String(Lines.at(-1).length + 1);
  }

  function UpdateLineNumbers() {
    const Count = Math.max(1, Elements.Editor.value.split('\n').length);
    Elements.LineNumbers.textContent = Array.from({ length: Count }, (_, Index) => Index + 1).join('\n');
    Elements.LineNumbers.scrollTop = Elements.Editor.scrollTop;
  }

  function SetDirty(Dirty) {
    State.Dirty = Dirty;
    Elements.Save.disabled = !State.CurrentPath || !Dirty;
    Elements.EditorState.textContent = State.CurrentPath ? (Dirty ? 'Unsaved changes' : 'Saved') : 'No file selected';
    Elements.EditorState.dataset.dirty = String(Dirty);
  }

  function ReloadPreview(Path = '') {
    const Target = Path && Path !== 'index.html' ? `${State.PublicUrl}${Path}` : State.PublicUrl;
    const Separator = Target.includes('?') ? '&' : '?';
    Elements.Preview.src = `${Target}${Separator}workspacePreview=${Date.now()}`;
  }

  function RenderTree() {
    Elements.Tree.replaceChildren();
    if (!State.Files.length) {
      const Empty = document.createElement('div');
      Empty.className = 'file-empty';
      Empty.textContent = 'This workspace is empty.';
      Elements.Tree.append(Empty);
      return;
    }
    for (const Entry of State.Files) {
      const Row = document.createElement('button');
      Row.type = 'button';
      Row.className = 'file-row';
      Row.dataset.path = Entry.Path;
      Row.dataset.directory = String(Entry.Type === 'directory');
      Row.dataset.selected = String(Entry.Path === State.CurrentPath);
      Row.style.paddingLeft = `${.45 + (Entry.Path.split('/').length - 1) * .9}rem`;
      const Icon = document.createElement('span');
      Icon.textContent = Entry.Type === 'directory' ? '▸' : Entry.Editable ? '◇' : '◆';
      const Name = document.createElement('span');
      Name.className = 'file-row__name';
      Name.textContent = Entry.Name;
      const Size = document.createElement('span');
      Size.className = 'file-row__size';
      Size.textContent = Entry.Size === null ? '' : FormatBytes(Entry.Size);
      Row.append(Icon, Name, Size);
      Row.addEventListener('click', () => SelectEntry(Entry));
      Elements.Tree.append(Row);
    }
  }

  async function LoadFiles(PreferredPath = State.CurrentPath) {
    const Payload = await Api(GetApiPath('files'));
    State.Files = Payload.Files;
    Elements.FileCount.textContent = String(Payload.Summary.Files);
    Elements.ByteCount.textContent = FormatBytes(Payload.Summary.Bytes);
    RenderTree();
    if (PreferredPath) {
      const Entry = State.Files.find((Item) => Item.Path === PreferredPath);
      if (Entry?.Editable) await LoadFile(Entry.Path);
    }
  }

  async function ConfirmDiscard() {
    if (!State.Dirty) return true;
    return ShowDialog({ Title: 'Discard unsaved changes?', Message: `${State.CurrentPath} has changes that have not been saved.`, ConfirmLabel: 'Discard', Danger: true });
  }

  async function SelectEntry(Entry) {
    if (Entry.Path === State.CurrentPath) return;
    if (!await ConfirmDiscard()) return;
    if (Entry.Type === 'directory') {
      State.CurrentPath = Entry.Path;
      State.Revision = '';
      Elements.Editor.value = '';
      Elements.Editor.disabled = true;
      Elements.EditorPath.textContent = Entry.Path;
      Elements.EditorMode.textContent = 'DIRECTORY';
      Elements.FindToggle.disabled = true;
      Elements.Rename.disabled = false;
      Elements.Delete.disabled = false;
      SetDirty(false);
      RenderTree();
      return;
    }
    if (!Entry.Editable) {
      State.CurrentPath = Entry.Path;
      State.Revision = '';
      Elements.Editor.value = '';
      Elements.Editor.disabled = true;
      Elements.EditorPath.textContent = Entry.Path;
      Elements.EditorMode.textContent = 'BINARY';
      Elements.FindToggle.disabled = true;
      Elements.Rename.disabled = false;
      Elements.Delete.disabled = false;
      SetDirty(false);
      RenderTree();
      ReloadPreview(Entry.Path);
      ShowNotice(`${Entry.Path} is a binary asset. You can replace, rename, preview, or delete it.`, '');
      return;
    }
    await LoadFile(Entry.Path);
  }

  async function LoadFile(FilePath) {
    ShowNotice(`Opening ${FilePath}…`, 'working');
    try {
      const File = await Api(GetApiPath('file', FilePath));
      State.CurrentPath = FilePath;
      State.Revision = File.Revision;
      Elements.Editor.value = File.Content;
      Elements.Editor.disabled = false;
      Elements.EditorPath.textContent = FilePath;
      Elements.EditorMode.textContent = GetMode(FilePath);
      Elements.FindToggle.disabled = false;
      Elements.Rename.disabled = false;
      Elements.Delete.disabled = false;
      SetDirty(false);
      UpdateLineNumbers();
      UpdateCursor();
      RenderTree();
      ShowNotice(`${FilePath} loaded.`, 'success');
    } catch (Error) {
      ShowNotice(Error.message, 'error');
    }
  }

  async function SaveFile() {
    if (!State.CurrentPath || !State.Dirty) return;
    ShowNotice(`Saving ${State.CurrentPath}…`, 'working');
    try {
      const Result = await Api(GetApiPath('file', State.CurrentPath), {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': State.Revision },
        body: Elements.Editor.value,
      });
      State.Revision = Result.Revision;
      SetDirty(false);
      await LoadFiles(State.CurrentPath);
      ReloadPreview();
      ShowNotice(`${State.CurrentPath} saved and published.`, 'success');
    } catch (Error) {
      ShowNotice(Error.message, 'error');
    }
  }

  function ShowDialog({ Title, Message = '', InputLabel = '', InputValue = '', ConfirmLabel = 'Continue', Danger = false }) {
    return new Promise((Resolve) => {
      const Dialog = document.createElement('dialog');
      Dialog.className = 'workspace-dialog';
      const Form = document.createElement('form');
      Form.method = 'dialog';
      const Heading = document.createElement('h2');
      Heading.textContent = Title;
      Form.append(Heading);
      if (Message) {
        const Copy = document.createElement('p');
        Copy.className = 'muted';
        Copy.textContent = Message;
        Form.append(Copy);
      }
      let Input = null;
      if (InputLabel) {
        const Label = document.createElement('label');
        Label.textContent = InputLabel;
        Input = document.createElement('input');
        Input.value = InputValue;
        Input.required = true;
        Label.append(Input);
        Form.append(Label);
      }
      const Actions = document.createElement('div');
      Actions.className = 'actions';
      const Cancel = document.createElement('button');
      Cancel.type = 'button';
      Cancel.className = 'secondary';
      Cancel.textContent = 'Cancel';
      const Confirm = document.createElement('button');
      Confirm.type = 'submit';
      Confirm.className = Danger ? 'danger' : '';
      Confirm.textContent = ConfirmLabel;
      Actions.append(Cancel, Confirm);
      Form.append(Actions);
      Dialog.append(Form);
      document.body.append(Dialog);
      const Finish = (Value) => { Dialog.close(); Dialog.remove(); Resolve(Value); };
      Cancel.addEventListener('click', () => Finish(Input ? null : false));
      Form.addEventListener('submit', (Event) => { Event.preventDefault(); Finish(Input ? Input.value.trim() : true); });
      Dialog.addEventListener('cancel', (Event) => { Event.preventDefault(); Finish(Input ? null : false); });
      Dialog.showModal();
      Input?.focus();
      Input?.select();
    });
  }

  async function CreateFile() {
    const BasePath = State.CurrentPath && State.Files.find((Entry) => Entry.Path === State.CurrentPath)?.Type === 'directory' ? `${State.CurrentPath}/` : `${GetParentPath(State.CurrentPath)}/`;
    const FilePath = await ShowDialog({ Title: 'Create a file', InputLabel: 'Workspace path', InputValue: `${BasePath === '/' ? '' : BasePath}untitled.html`, ConfirmLabel: 'Create' });
    if (!FilePath) return;
    try {
      await Api(GetApiPath('file', FilePath), { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: '' });
      await LoadFiles(FilePath);
      ShowNotice(`${FilePath} created.`, 'success');
    } catch (Error) { ShowNotice(Error.message, 'error'); }
  }

  async function CreateFolder() {
    const BasePath = State.CurrentPath && State.Files.find((Entry) => Entry.Path === State.CurrentPath)?.Type === 'directory' ? `${State.CurrentPath}/` : `${GetParentPath(State.CurrentPath)}/`;
    const FolderPath = await ShowDialog({ Title: 'Create a folder', InputLabel: 'Workspace path', InputValue: `${BasePath === '/' ? '' : BasePath}assets`, ConfirmLabel: 'Create' });
    if (!FolderPath) return;
    try {
      await Api(GetApiPath('directory'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ path: FolderPath }) });
      await LoadFiles();
      ShowNotice(`${FolderPath} created.`, 'success');
    } catch (Error) { ShowNotice(Error.message, 'error'); }
  }

  async function RenameSelected() {
    if (!State.CurrentPath) return;
    const Destination = await ShowDialog({ Title: 'Rename or move', Message: `Current path: ${State.CurrentPath}`, InputLabel: 'New workspace path', InputValue: State.CurrentPath, ConfirmLabel: 'Rename' });
    if (!Destination || Destination === State.CurrentPath) return;
    try {
      await Api(GetApiPath('rename'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ path: State.CurrentPath, destination: Destination }) });
      State.CurrentPath = Destination;
      State.Revision = '';
      SetDirty(false);
      await LoadFiles(Destination);
      ReloadPreview();
      ShowNotice(`Moved to ${Destination}.`, 'success');
    } catch (Error) { ShowNotice(Error.message, 'error'); }
  }

  async function DeleteSelected() {
    if (!State.CurrentPath) return;
    const DeletedPath = State.CurrentPath;
    const Confirmed = await ShowDialog({ Title: `Delete ${DeletedPath}?`, Message: 'A private recovery snapshot will be retained in this workspace.', ConfirmLabel: 'Delete', Danger: true });
    if (!Confirmed) return;
    try {
      await Api(GetApiPath('path', DeletedPath), { method: 'DELETE' });
      State.CurrentPath = '';
      State.Revision = '';
      Elements.Editor.value = '';
      Elements.Editor.disabled = true;
      Elements.EditorPath.textContent = 'Select a text file';
      Elements.Rename.disabled = true;
      Elements.Delete.disabled = true;
      Elements.FindToggle.disabled = true;
      SetDirty(false);
      await LoadFiles();
      ReloadPreview();
      ShowNotice(`${DeletedPath} deleted; a recovery snapshot was kept.`, 'success');
    } catch (Error) { ShowNotice(Error.message, 'error'); }
  }

  async function UploadFiles(Files, PreservePaths = false) {
    if (!Files.length) return;
    const Selected = State.Files.find((Entry) => Entry.Path === State.CurrentPath);
    const Directory = Selected?.Type === 'directory' ? Selected.Path : GetParentPath(State.CurrentPath);
    let Completed = 0;
    for (const File of Files) {
      const UploadPath = PreservePaths && File.webkitRelativePath ? File.webkitRelativePath : File.name;
      const FilePath = [Directory, UploadPath].filter(Boolean).join('/');
      ShowNotice(`Uploading ${FilePath} (${Completed + 1}/${Files.length})…`, 'working');
      try {
        await Api(GetApiPath('upload', FilePath), { method: 'POST', headers: { 'Content-Type': File.type || 'application/octet-stream' }, body: File });
        Completed += 1;
      } catch (Error) {
        ShowNotice(`${FilePath}: ${Error.message}`, 'error');
        await LoadFiles();
        return;
      }
    }
    Elements.Upload.value = '';
    Elements.FolderUpload.value = '';
    await LoadFiles();
    ReloadPreview();
    ShowNotice(`${Completed} file${Completed === 1 ? '' : 's'} uploaded and published.`, 'success');
  }

  function FindNext() {
    const Query = Elements.FindText.value;
    if (!Query) return;
    const Start = Elements.Editor.selectionEnd;
    let Index = Elements.Editor.value.indexOf(Query, Start);
    if (Index < 0) Index = Elements.Editor.value.indexOf(Query);
    if (Index >= 0) {
      Elements.Editor.focus();
      Elements.Editor.setSelectionRange(Index, Index + Query.length);
      UpdateCursor();
    } else ShowNotice(`“${Query}” was not found.`, '');
  }

  function ReplaceOne() {
    const Query = Elements.FindText.value;
    if (!Query) return;
    const Selected = Elements.Editor.value.slice(Elements.Editor.selectionStart, Elements.Editor.selectionEnd);
    if (Selected !== Query) return FindNext();
    Elements.Editor.setRangeText(Elements.ReplaceText.value, Elements.Editor.selectionStart, Elements.Editor.selectionEnd, 'end');
    Elements.Editor.dispatchEvent(new Event('input'));
    FindNext();
  }

  function ReplaceAll() {
    const Query = Elements.FindText.value;
    if (!Query) return;
    const Count = Elements.Editor.value.split(Query).length - 1;
    if (!Count) return ShowNotice(`“${Query}” was not found.`, '');
    Elements.Editor.value = Elements.Editor.value.split(Query).join(Elements.ReplaceText.value);
    Elements.Editor.dispatchEvent(new Event('input'));
    ShowNotice(`Replaced ${Count} occurrence${Count === 1 ? '' : 's'}.`, 'success');
  }

  Elements.Editor.addEventListener('input', () => { SetDirty(true); UpdateLineNumbers(); UpdateCursor(); });
  Elements.Editor.addEventListener('click', UpdateCursor);
  Elements.Editor.addEventListener('keyup', UpdateCursor);
  Elements.Editor.addEventListener('scroll', () => { Elements.LineNumbers.scrollTop = Elements.Editor.scrollTop; });
  Elements.Editor.addEventListener('keydown', (Event) => {
    if ((Event.ctrlKey || Event.metaKey) && Event.key.toLowerCase() === 's') { Event.preventDefault(); SaveFile(); }
    if ((Event.ctrlKey || Event.metaKey) && Event.key.toLowerCase() === 'f') { Event.preventDefault(); Elements.FindBar.hidden = false; Elements.FindText.focus(); }
    if (Event.key === 'Tab' && !Event.ctrlKey && !Event.metaKey) {
      Event.preventDefault();
      Elements.Editor.setRangeText('  ', Elements.Editor.selectionStart, Elements.Editor.selectionEnd, 'end');
      Elements.Editor.dispatchEvent(new Event('input'));
    }
  });
  Elements.Save.addEventListener('click', SaveFile);
  Elements.Rename.addEventListener('click', RenameSelected);
  Elements.Delete.addEventListener('click', DeleteSelected);
  Elements.FindToggle.addEventListener('click', () => { Elements.FindBar.hidden = !Elements.FindBar.hidden; if (!Elements.FindBar.hidden) Elements.FindText.focus(); });
  document.querySelector('#FindNext').addEventListener('click', FindNext);
  document.querySelector('#ReplaceOne').addEventListener('click', ReplaceOne);
  document.querySelector('#ReplaceAll').addEventListener('click', ReplaceAll);
  document.querySelector('#ReloadPreview').addEventListener('click', () => ReloadPreview());
  Elements.Upload.addEventListener('change', () => UploadFiles([...Elements.Upload.files]));
  Elements.FolderUpload.addEventListener('change', () => UploadFiles([...Elements.FolderUpload.files], true));
  document.querySelectorAll('[data-workspace-action]').forEach((Button) => Button.addEventListener('click', () => {
    const Actions = { 'new-file': CreateFile, 'new-folder': CreateFolder, refresh: () => LoadFiles() };
    Actions[Button.dataset.workspaceAction]?.();
  }));
  window.addEventListener('beforeunload', (Event) => { if (State.Dirty) { Event.preventDefault(); Event.returnValue = ''; } });

  LoadFiles('index.html').catch((Error) => ShowNotice(Error.message, 'error'));
}
