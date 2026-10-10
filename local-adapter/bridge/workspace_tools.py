"""Bounded UTF-8 file operations in one locally configured workspace.

Windows handles pin directories and prohibit other writers/renames while a file
revision is checked and changed. The history store is outside the model's root.
"""
from pathlib import Path, PurePosixPath
from contextlib import contextmanager, ExitStack
import hashlib, json, os, re, stat, threading, time, uuid

MAX_BYTES=64000
MAX_HISTORY=256
TOOLS=('files_list','files_read','files_search','files_write','files_undo')
CATALOG=[
 {'tool':'files_list','args':{'path':'relative directory, default .'},'description':'List at most 100 names in one directory.'},
 {'tool':'files_read','args':{'path':'relative file','offset':'optional character offset'},'description':'Read up to 12000 UTF-8 characters and the sha256 version; read more with offset.'},
 {'tool':'files_search','args':{'query':'literal text, max 100 characters'},'description':'Search bounded UTF-8 files. No regex. Returns file names and line numbers, max 30 matches.'},
 {'tool':'files_write','args':{'path':'relative file','text':'full new UTF-8 content, max 64000 bytes','expectedVersion':'sha256 from files_read, or null for a new file'},'description':'Create or replace text with revision check and recoverable history. Parent directory must exist.'},
 {'tool':'files_undo','args':{'changeId':'ID returned by files_write','expectedVersion':'current sha256 from files_read'},'description':'Restore a previous change only if the current revision still matches. New files are removed with a recoverable backup.'},
]

def digest(data):return hashlib.sha256(data).hexdigest()
def plain(data):
    if len(data)>MAX_BYTES or any(byte<32 and byte not in (9,10,13) for byte in data):raise ValueError('Filen är för stor eller är inte en textfil.')
    try:return data.decode('utf-8')
    except UnicodeDecodeError:raise ValueError('Filen behöver vara UTF-8-text.') from None

def safe_part(part):
    return bool(part and part not in ('.','..') and not part.endswith((' ','.')) and
        not re.search(r'[\x00-\x1f<>:"\\|?*]',part) and
        not re.match(r'^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)',part,re.I))

def check_link(path):
    info=path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
        raise ValueError('Länkar och junctions får inte användas i arbetsmappen.')
    return info

@contextmanager
def win_handle(path,access,directory=False,create=False):
    import ctypes
    from ctypes import wintypes
    api=ctypes.WinDLL('kernel32',use_last_error=True)
    api.CreateFileW.argtypes=[wintypes.LPCWSTR,wintypes.DWORD,wintypes.DWORD,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.HANDLE]
    api.CreateFileW.restype=wintypes.HANDLE
    api.CloseHandle.argtypes=[wintypes.HANDLE]
    handle=api.CreateFileW(str(path),access,1,None,1 if create else 3,0x00200000|(0x02000000 if directory else 0),None)
    if handle==ctypes.c_void_p(-1).value:raise OSError(ctypes.get_last_error(),'Filen är upptagen eller kunde inte öppnas.')
    try:yield handle
    finally:api.CloseHandle(handle)

class Workspace:
    def __init__(self,root,history):
        self.root=Path(root).absolute();self.history=Path(history).absolute();self.lock=threading.RLock()
        if self.history==self.root or self.history.is_relative_to(self.root):raise ValueError('Filhistoriken måste ligga utanför arbetsmappen.')
        if not self.root.is_dir():raise ValueError('Arbetsmappen saknas.')
        check_link(self.root)
        self.history.mkdir(parents=True,exist_ok=True)
        check_link(self.history)

    def path(self,value,allow_root=False):
        if not isinstance(value,str) or len(value)>240:raise ValueError('Ange en relativ filväg i arbetsmappen.')
        if value=='.' and allow_root:return self.root
        parts=PurePosixPath(value).parts
        if not value or value.startswith('/') or not parts or any(not safe_part(part) for part in parts):raise ValueError('Filvägen är inte tillåten.')
        # Reject normalized-away . and empty parts too.
        if any(not safe_part(part) for part in value.split('/')):raise ValueError('Filvägen är inte tillåten.')
        result=self.root.joinpath(*parts)
        if not result.is_relative_to(self.root):raise ValueError('Filvägen ligger utanför arbetsmappen.')
        return result

    @contextmanager
    def pinned(self,path):
        # Include ancestors: replacing any directory must not redirect a write.
        with ExitStack() as stack:
            chain=list(reversed(path.parent.parents))+[path.parent]
            for directory in chain:
                if os.name=='nt':stack.enter_context(win_handle(directory,0,directory=True))
                info=check_link(directory)
                if not stat.S_ISDIR(info.st_mode):raise ValueError('Filens överordnade mapp saknas.')
            yield

    @contextmanager
    def opened(self,path,write=False,create=False):
        with self.pinned(path):
            if not create:
                info=check_link(path)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('Endast vanliga filer utan hårda länkar tillåts.')
            if os.name=='nt':
                import msvcrt, ctypes
                with win_handle(path,0x80000000|(0x40000000|0x10000 if write else 0),create=create) as handle:
                    # Duplicate so the fd owns its handle independently.
                    from ctypes import wintypes
                    api=ctypes.WinDLL('kernel32',use_last_error=True)
                    api.GetCurrentProcess.restype=wintypes.HANDLE
                    api.DuplicateHandle.argtypes=[wintypes.HANDLE,wintypes.HANDLE,wintypes.HANDLE,ctypes.POINTER(wintypes.HANDLE),wintypes.DWORD,wintypes.BOOL,wintypes.DWORD]
                    copy=wintypes.HANDLE();current=api.GetCurrentProcess()
                    if not api.DuplicateHandle(current,handle,current,ctypes.byref(copy),0,False,2):raise OSError('Filen kunde inte låsas.')
                    fd=msvcrt.open_osfhandle(copy.value,os.O_BINARY|(os.O_RDWR if write else os.O_RDONLY))
                    with os.fdopen(fd,'r+b' if write else 'rb') as stream:
                        info=check_link(path)
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('Filen är inte tillåten.')
                        yield stream,handle
            else:
                flags=(os.O_RDWR if write else os.O_RDONLY)|getattr(os,'O_NOFOLLOW',0)|(os.O_CREAT|os.O_EXCL if create else 0)
                fd=os.open(path,flags,0o600)
                with os.fdopen(fd,'r+b' if write else 'rb') as stream:
                    info=os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('Filen är inte tillåten.')
                    yield stream,None

    def status(self):return {'enabled':True,'name':self.root.name,'tools':list(TOOLS),'maxFileBytes':MAX_BYTES}

    def read(self,path,offset=0):
        if not isinstance(offset,int) or isinstance(offset,bool) or not 0<=offset<=MAX_BYTES:raise ValueError('Ogiltig textposition.')
        target=self.path(path)
        with self.lock,self.opened(target) as (stream,_):data=stream.read(MAX_BYTES+1)
        text=plain(data)
        return {'path':path,'version':digest(data),'text':text[offset:offset+12000],'nextOffset':offset+12000 if len(text)>offset+12000 else None,'characters':len(text)}

    def listing(self,path='.'):
        target=self.path(path,True);items=[]
        with self.lock,self.pinned(target/'_probe'):
            check_link(target)
            entries,truncated=self.entries(target)
            for item in entries:
                try:
                    info=check_link(item)
                    if not safe_part(item.name) or info.st_nlink>1 and stat.S_ISREG(info.st_mode):continue
                    items.append({'path':item.relative_to(self.root).as_posix(),'type':'directory' if item.is_dir() else 'file','bytes':info.st_size})
                except (ValueError,OSError):continue
                if len(items)==100:break
        return {'items':items,'truncated':truncated or len(items)==100}

    def entries(self,directory):
        # Bound enumeration before sorting, including directories with no files.
        items=[]
        with os.scandir(directory) as scan:
            for item in scan:
                if len(items)==500:return sorted(items),True
                items.append(Path(item.path))
        return sorted(items),False

    def search(self,query):
        if not isinstance(query,str) or not 1<=len(query)<=100 or '\0' in query:raise ValueError('Sök med 1–100 tecken.')
        matches=[];visited=0;directories=[self.root];scanned=0;truncated=False
        while directories:
            if scanned==100:return {'matches':matches,'truncated':True}
            directory=directories.pop();scanned+=1
            try:
                with self.lock,self.pinned(directory/'_probe'):
                    entries,limited=self.entries(directory);truncated=truncated or limited
                    files=[]
                    for item in entries:
                        try:info=check_link(item)
                        except (ValueError,OSError):continue
                        if not safe_part(item.name):continue
                        if stat.S_ISDIR(info.st_mode):
                            if len(directories)+scanned<100:directories.append(item)
                            else:truncated=True
                        elif stat.S_ISREG(info.st_mode):files.append(item)
            except (ValueError,OSError):continue
            for item in files:
                visited+=1
                if visited>200:return {'matches':matches,'truncated':True}
                path=item.relative_to(self.root).as_posix()
                try:
                    with self.lock,self.opened(self.path(path)) as (stream,_):text=plain(stream.read(MAX_BYTES+1))
                except (ValueError,OSError):continue
                for number,line in enumerate(text.splitlines(),1):
                    if query.casefold() in line.casefold():matches.append({'path':path,'line':number,'excerpt':line[:240]})
                    if len(matches)>=30:return {'matches':matches,'truncated':True}
        return {'matches':matches,'truncated':truncated}

    def records(self):
        return sorted(self.history.glob('*.json'),key=lambda p:p.name,reverse=True)

    def save_record(self,record):
        path=self.history/(record['id']+'.json');temp=path.with_suffix('.tmp')
        temp.write_text(json.dumps(record,ensure_ascii=False),encoding='utf-8');os.replace(temp,path)

    def activity(self):
        items=[]
        with self.lock:
            for path in self.records()[:20]:
                row=json.loads(path.read_text(encoding='utf-8'))
                if row['state']=='undone' and row['beforeVersion'] is None:
                    items.append({'id':row['id'],'path':row['path'],'beforeVersion':None,'afterVersion':None,'time':row['time'],'action':'undo-create'})
                    continue
                if row['state']!='done':continue
                items.append({key:row[key] for key in ('id','path','beforeVersion','afterVersion','time','action')})
        return items

    def write(self,path,text,expectedVersion):
        if not isinstance(text,str):raise ValueError('Ange textinnehåll.')
        data=text.encode('utf-8');plain(data)
        if expectedVersion is not None and (not isinstance(expectedVersion,str) or not re.fullmatch('[a-f0-9]{64}',expectedVersion)):raise ValueError('Ange filversionen från läsningen.')
        target=self.path(path)
        with self.lock:
            if len(self.records())>=MAX_HISTORY:raise ValueError('Filhistoriken är full. Ändringen har inte genomförts.')
            create=expectedVersion is None
            # CREATE_NEW or O_EXCL rejects an existing file instead of truncating it.
            with self.opened(target,write=True,create=create) as (stream,_):
                old=stream.read(MAX_BYTES+1);plain(old)
                if not create and digest(old)!=expectedVersion:raise ValueError('Filen har ändrats. Läs in den igen innan du skriver.')
                row={'id':str(time.time_ns())+'-'+uuid.uuid4().hex,'path':path,'beforeVersion':None if create else digest(old),'afterVersion':digest(data),'time':int(time.time()*1000),'action':'create' if create else 'edit','state':'pending'}
                backup=self.history/(row['id']+'.bin');backup.write_bytes(old)
                self.save_record(row)
                try:
                    stream.seek(0);stream.write(data);stream.truncate();stream.flush();os.fsync(stream.fileno())
                except OSError:
                    stream.seek(0);stream.write(old);stream.truncate();stream.flush();os.fsync(stream.fileno())
                    raise ValueError('Ändringen misslyckades; föregående text återställdes.') from None
                row['state']='done';self.save_record(row)
            return {'path':path,'version':row['afterVersion'],'changeId':row['id'],'action':row['action']}

    def undo(self,changeId,expectedVersion):
        if not isinstance(changeId,str) or not re.fullmatch(r'[0-9]{10,22}-[a-f0-9]{32}',changeId):raise ValueError('Ogiltig ändring.')
        with self.lock:
            row=json.loads((self.history/(changeId+'.json')).read_text(encoding='utf-8'))
            if row['state']=='undone' and row['beforeVersion'] is None and expectedVersion is None:
                data=(self.history/(changeId+'.created.bin')).read_bytes();plain(data)
                result=self.write(row['path'],plain(data),None)
                row['state']='redone';self.save_record(row)
                return result
            if row['state']!='done':raise ValueError('Ändringen är redan återställd eller ofullständig.')
            if expectedVersion!=row['afterVersion']:raise ValueError('Återställ bara den oförändrade filversionen.')
            old=(self.history/(changeId+'.bin')).read_bytes();plain(old)
            target=self.path(row['path'])
            if row['beforeVersion'] is not None:
                result=self.write(row['path'],plain(old),expectedVersion)
            else:
                with self.opened(target,write=True) as (stream,handle):
                    data=stream.read(MAX_BYTES+1);plain(data)
                    if digest(data)!=expectedVersion:raise ValueError('Filen har ändrats. Återställningen avbröts.')
                    (self.history/(changeId+'.created.bin')).write_bytes(data)
                    if os.name=='nt':
                        import ctypes
                        from ctypes import wintypes
                        api=ctypes.WinDLL('kernel32',use_last_error=True)
                        api.SetFileInformationByHandle.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
                        flag=ctypes.c_ubyte(1)
                        if not api.SetFileInformationByHandle(handle,4,ctypes.byref(flag),ctypes.sizeof(flag)):raise OSError('Filen kunde inte återställas.')
                    else:os.unlink(target)
                result={'path':row['path'],'version':None,'action':'undo-create','changeId':changeId}
            row['state']='undone';self.save_record(row)
            return result

    def execute(self,tool,args):
        allowed={'files_list':({'path'},self.listing),'files_read':({'path','offset'},self.read),'files_search':({'query'},self.search),'files_write':({'path','text','expectedVersion'},self.write),'files_undo':({'changeId','expectedVersion'},self.undo)}
        if tool not in allowed or not isinstance(args,dict) or set(args)-allowed[tool][0]:raise ValueError('Verktyget eller argumenten är inte tillåtna.')
        try:return allowed[tool][1](**args)
        except TypeError:raise ValueError('Verktygets argument saknas eller är ogiltiga.') from None

_workspace=None
def configured():
    global _workspace
    if os.name!='nt':return None  # The current production boundary uses Windows handles.
    config=Path(__file__).parent/'private/workspace.json'
    if not config.is_file():return None
    try:
        data=json.loads(config.read_text(encoding='utf-8'))
        if data.get('enabled') is not True or not isinstance(data.get('root'),str) or not Path(data['root']).is_absolute():return None
        if _workspace is None or str(_workspace.root)!=data['root']:
            _workspace=Workspace(data['root'],config.parent/'file-history')
        return _workspace
    except (ValueError,OSError,KeyError):return None
