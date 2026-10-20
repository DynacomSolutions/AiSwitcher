import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const root = join(import.meta.dir, '../../image/lib');
const table = readFileSync(join(root, 'ais-guard-table'), 'utf8');
const daemon = readFileSync(join(root, 'ais-guardd'), 'utf8');
const client = readFileSync(join(root, 'ais-guard'), 'utf8');

describe('live image guard contract', () => {
  test('table has unique command names and target rules', () => {
    const rows = table.split('\n').filter((line) => line && !line.startsWith('#'));
    const names = rows.map((line) => line.split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(rows.every((line) => /^(\S+) (destructive (device-[a-z-]+|none)|readonly-subcommands:[A-Za-z-]+ (device-[a-z-]+|none))$/.test(line))).toBe(true);
  });

  test('daemon requires socket activation and validates peer identity', () => {
    expect(daemon).toContain("LISTEN_PID");
    expect(daemon).toContain('SO_PEERCRED');
    expect(daemon).toContain("uid!=uid_for('agent')");
    expect(daemon).toContain("SCM_RIGHTS");
  });

  test('client passes argv and stdio descriptors and fails closed', () => {
    expect(client).toContain("SCM_RIGHTS");
    expect(client).toContain("return 126");
    expect(client).toContain("ais-aur");
  });

  test('daemon enforces bounded approval and exact device identity', () => {
    expect(daemon).toContain('len(stamps)>=6');
    expect(daemon).toContain('compare_digest');
    expect(daemon).toContain('st_rdev!=rdev');
    expect(daemon).toContain('DevicePolicy=closed');
    expect(daemon).toContain('ProtectSystem=strict');
  });


  test('daemon receives the JSON frame and three descriptors in one transport', () => {
    const script = String.raw`
import array, importlib.machinery, importlib.util, json, os, socket, sys
sys.path.insert(0,'image/lib')
path='image/lib/ais-guardd'
loader=importlib.machinery.SourceFileLoader('guardd',path)
spec=importlib.util.spec_from_loader(loader.name,loader)
m=importlib.util.module_from_spec(spec);loader.exec_module(m)
a,b=socket.socketpair()
fds=array.array('i',[0,1,2])
a.sendmsg([b'{"op":"disk","argv":["dd"],"cwd":"/"}\n'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,fds)])
r,received=m.recv_req(b)
assert r['op']=='disk' and r['argv']==['dd'] and len(received)==3
for fd in received: os.close(fd)
a.close();b.close()
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('malformed framing closes received descriptors and rate limiting persists per uid', () => {
    const script = String.raw`
import array, importlib.machinery, importlib.util, os, socket, sys, time
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
a,b=socket.socketpair(); r,w=os.pipe(); before=len(os.listdir('/proc/self/fd'))
a.sendmsg([b'{"op":"disk"}\nEXTRA'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[r]))]); os.close(r)
try: m.recv_req(b)
except ValueError: pass
else: raise AssertionError('extra frame bytes accepted')
after=len(os.listdir('/proc/self/fd')); assert after<=before
a.close();b.close();os.close(w)
m.RATE.clear()
for _ in range(6): m.rate_check(321)
try: m.rate_check(321)
except ValueError: pass
else: raise AssertionError('seventh approval accepted')
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('policy accepts exact read-only forms and rejects mutation-shaped argv', () => {
    const script = String.raw`
import sys
sys.path.insert(0,'image/lib')
from ais_guard_policy import readonly, pacman_args, timeout_for, escape_display
assert readonly('lsblk',['-J','-o','PATH,SIZE'])
assert not readonly('lsblk',['--output-all'])
assert readonly('blkid',[])
assert readonly('findmnt',['-J','-o','TARGET,SOURCE'])
assert not readonly('findmnt',['--evaluate'])
assert pacman_args(['-S','synthetic-fixture']) == ('repository',['-S','synthetic-fixture'])
assert pacman_args(['-U','fixture.pkg.tar.zst'])[0] == 'files'
try: pacman_args(['--config','synthetic-fixture'])
except ValueError: pass
else: raise AssertionError('unsafe pacman accepted')
assert timeout_for(['ais.test=1','ais.guard_timeout=2']) == 2
assert timeout_for(['ais.guard_timeout=2']) == 120
assert '\\x1b' in escape_display('\x1b[31m')
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('daemon replies run-locally for no-device execution and refuses invalid read-only argv', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, socket, struct, sys
sys.path.insert(0,'image/lib')
loader=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
spec=importlib.util.spec_from_loader(loader.name,loader); m=importlib.util.module_from_spec(spec); loader.exec_module(m)
class Conn:
 def __init__(self,req): self.req=req; self.sent=[]; self.closed=False
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',os.getpid(),os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): self.closed=True
m.uid_for=lambda name: os.getuid()
m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
m.COMMANDS={'dd','lsblk'}
m.resolve_devices=lambda name,args,cwd:(args,[])
calls=[]
m.run_root=lambda *a,**kw:calls.append(a)
c=Conn({'op':'disk','argv':['dd','if=/dev/zero'],'cwd':'/'})
m.handle(c)
assert not calls and c.sent[-1]=={'approved':True,'reason':'local'} and c.closed
calls.clear(); c=Conn({'op':'disk','argv':['lsblk','--unsafe'],'cwd':'/'})
m.handle(c)
assert not calls and c.sent[-1]['approved'] is False and c.closed
for bad in (
 {'op':'disk','argv':'dd','cwd':'/'},
 {'op':'unknown','argv':['dd'],'cwd':'/'},
):
 c=Conn(bad); m.handle(c); assert not calls and c.sent[-1]['approved'] is False and c.closed
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('device writes require the exact popup response before root execution', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, socket, struct, sys, types
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class Conn:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',os.getpid(),os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda name: os.getuid(); m.COMMANDS={'dd'}
m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
m.resolve_devices=lambda n,a,c:(a,[('/dev/fake','/dev/fake',99)])
m.popup=lambda *a: True
oldstat=os.stat
os.stat=lambda p,*a,**kw:(types.SimpleNamespace(st_rdev=99) if p=='/dev/fake' else oldstat(p,*a,**kw))
calls=[]; m.run_root=lambda argv,fds,devs,readonly_mode=False,cwd='/':(calls.append((argv,list(fds),devs,readonly_mode)) or 23)
c=Conn({'op':'disk','argv':['dd','of=/dev/fake'],'cwd':'/'})
m.handle(c)
assert len(calls)==1 and calls[0][0]==['/usr/bin/dd','of=/dev/fake']
assert len(calls[0][1])==3 and c.sent[-1]['approved'] is True and c.sent[-1]['exit_code']==23
calls.clear(); m.popup=lambda *a:False
c=Conn({'op':'disk','argv':['dd','of=/dev/fake'],'cwd':'/'})
m.handle(c)
assert not calls and c.sent[-1]['approved'] is False
for failure in (TimeoutError('popup timeout'), RuntimeError('herdr unavailable'), ValueError('malformed reply')):
 def fail(*a,e=failure): raise e
 m.popup=fail
 c=Conn({'op':'disk','argv':['dd','of=/dev/fake'],'cwd':'/'})
 m.handle(c)
 assert not calls and c.sent[-1]['approved'] is False
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('root runner enforces read-only versus read-write access and popup rejects bad peers/nonces', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, socket, struct, sys, types
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
calls=[]
class Result: returncode=0
m.subprocess.__dict__['run']=lambda *a,**kw:(calls.append((a,kw)) or Result())
m.run_root(['/usr/bin/blkid','/dev/fake'],[0,1,2],[('/dev/fake','/dev/fake',10)],True)
ro=' '.join(calls[-1][0][0]); assert 'DeviceAllow=/dev/fake r' in ro and 'DeviceAllow=/dev/fake rw' not in ro
assert 'ProtectSystem=strict' in ro and 'PrivateTmp=yes' in ro
for opt in ('NoExecPaths=/','ExecPaths=/usr','ProtectKernelTunables=yes','ProtectControlGroups=yes','ProtectKernelModules=yes'): assert opt in ro,opt
assert '--working-directory=/ ' in ro+' '
m.run_root(['/usr/bin/dd','if=./a'],[0,1,2],[('/dev/fake','/dev/fake',10)],False,'/srv/work')
assert '--working-directory=/srv/work' in calls[-1][0][0]
m.run_root(['/usr/bin/dd','of=/dev/fake'],[0,1,2],[('/dev/fake','/dev/fake',10)])
rw=' '.join(calls[-1][0][0]); assert 'DeviceAllow=/dev/fake rw' in rw
assert calls[-1][1]['env']=={'PATH':'/usr/bin:/bin','LANG':'C','LC_ALL':'C'}
m.uid_for=lambda name:os.getuid()
class Peer:
 def __init__(self,uid,data): self.uid=uid; self.data=data
 def getsockopt(self,*a): return struct.pack('3i',1,self.uid,os.getgid())
 def recv(self,n): d=self.data[:n]; self.data=self.data[n:]; return d
valid=json.dumps({'nonce':'fresh','text':'vdb'}).encode()+b'\n'
assert m.validate_reply(Peer(os.getuid(),valid),'fresh','vdb')
assert not m.validate_reply(Peer(os.getuid(),json.dumps({'nonce':'stale','text':'vdb'}).encode()+b'\n'),'fresh','vdb')
assert not m.validate_reply(Peer(os.getuid()+1,valid),'fresh','vdb')
assert not m.validate_reply(Peer(os.getuid(),json.dumps({'nonce':'fresh','text':'wrong'}).encode()+b'\n'),'fresh','vdb')
assert not m.validate_reply(Peer(os.getuid(),json.dumps({'nonce':'fresh','text':''}).encode()+b'\n'),'fresh','vdb')
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('every writable and mixed table command requires approval and executes once with passed descriptors', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, socket, struct, sys, types
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class Conn:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
m.rate_check=lambda uid:None
m.resolve_devices=lambda n,a,c:(a,[('/dev/fake','/dev/fake',44)])
oldstat=os.stat; os.stat=lambda p,*a,**kw:(types.SimpleNamespace(st_rdev=44) if p=='/dev/fake' else oldstat(p,*a,**kw))
calls=[]; m.run_root=lambda argv,fds,devs=(),readonly_mode=False,cwd='/':(calls.append((argv,list(fds))) or 0)
m.popup=lambda *a:True
rows=[line.split() for line in open('image/lib/ais-guard-table') if line.strip() and not line.lstrip().startswith('#')]
for name,classification,target in rows:
 if classification=='readonly-subcommands:all':
  c=Conn({'op':'disk','argv':[name,'/dev/fake'],'cwd':'/'})
  m.handle(c); assert c.sent[-1]['approved'] is False and not calls, name
  continue
 arg='of=/dev/fake' if name=='dd' else '/dev/fake'
 c=Conn({'op':'disk','argv':[name,arg],'cwd':'/'})
 m.handle(c)
 assert len(calls)==1 and calls[-1][0][0]=='/usr/bin/'+name, name
 assert len(calls[-1][1])==3 and c.sent[-1]['approved'] is True and c.sent[-1]['exit_code']==0, name
 calls.clear()
 m.popup=lambda *a:False
 c=Conn({'op':'disk','argv':[name,arg],'cwd':'/'})
 m.handle(c)
 assert not calls and c.sent[-1]['approved'] is False, name
 m.popup=lambda *a:True
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('package copies are immutable snapshots and read-only device metadata includes child mounts', () => {
    const scratch = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
    const script = String.raw`
import hashlib, importlib.machinery, importlib.util, json, os, sys, tempfile, types, secrets
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('guardd','image/lib/ais-guardd')
s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
tag=secrets.token_hex(12)
src=os.path.join(sys.argv[1],'package-copy-source-'+tag+'-SYNTHETIC_FIXTURE.pkg')
with open(src,'wb') as f:f.write(b'original-SYNTHETIC_FIXTURE')
m.P=os.path.join(sys.argv[1],'package-copy-dest-'+tag+'-SYNTHETIC_FIXTURE')
os.mkdir(m.P)
m.os.chown=lambda *a:None
m.pwd.getpwuid=lambda uid:types.SimpleNamespace(pw_gid=os.getgid(),pw_dir=os.path.dirname(src))
real_popen=m.subprocess.Popen
m.subprocess.Popen=lambda *a,**kw:real_popen(*a,**{k:v for k,v in kw.items() if k not in ('user','group','extra_groups')})
dest,digest=m.copy_pkg(src,os.getuid(),'copytest-SYNTHETIC_FIXTURE','/')
with open(src,'wb') as f:f.write(b'mutated-SYNTHETIC_FIXTURE')
assert open(dest,'rb').read()==b'original-SYNTHETIC_FIXTURE'
assert digest==hashlib.sha256(b'original-SYNTHETIC_FIXTURE').hexdigest()
os.unlink(dest); os.rmdir(os.path.dirname(dest)); os.rmdir(m.P); os.unlink(src)
class P:
 returncode=0
 stdout=json.dumps({'blockdevices':[{'path':'/dev/fake','model':'Synthetic','size':4096,'mountpoints':[None],'children':[{'mountpoints':['/synthetic-mount-SYNTHETIC_FIXTURE']},{'mountpoints':['/synthetic-mount-SYNTHETIC_FIXTURE','/another-SYNTHETIC_FIXTURE']}]}]})
m.subprocess.__dict__['run']=lambda *a,**kw:P()
info=m.device_info('/dev/fake')
assert info['mounts']==['/synthetic-mount-SYNTHETIC_FIXTURE','/another-SYNTHETIC_FIXTURE']
`;
    execFileSync('python3', ['-B', '-c', script, scratch], { cwd: join(import.meta.dir, '../..'), env: { ...process.env, AIS_TEST_SCRATCH_DIR: scratch } });
  });

  test('pacman -U requests independent approval per copied archive and installs noninteractively', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,json,os,sys
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class C:
 def __init__(self): self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): import struct; return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)]); m.rate_check=lambda u:None
m.pkg_name=lambda dest:'pkg-one' if 'one' in dest else 'pkg-two'
m.copy_pkg=lambda source,uid,rid,cwd:('/immutable/'+source,'hash-'+source)
approved=[]; m.popup=lambda command,devs,expected,timeout:(approved.append((command,expected)) or True)
class R: returncode=0
count=0
def run(argv,**kw):
 global count
 assert '--noconfirm' in argv and '-U' in argv and '--' in argv
 return R()
m.subprocess.__dict__['run']=run; m.os.unlink=lambda p:None; m.os.rmdir=lambda p:None
c=C(); c.req={'op':'pacman','argv':['pacman','-U','one.pkg.tar.zst','two.pkg.tar.zst'],'cwd':'/'}; m.handle(c)
assert [x[1] for x in approved]==['pkg-one','pkg-two'],(approved,c.sent)
assert all(('one.pkg.tar.zst' in x[0] or 'two.pkg.tar.zst' in x[0]) and 'hash-' in x[0] for x in approved)
assert c.sent[-1]['approved'] and c.sent[-1]['exit_code']==0
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('popup prints its prompt and exits on an expired request without sending a reply', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,json,os,sys,tempfile,time,io
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('pop','image/lib/ais-guard-popup'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
d=tempfile.mkdtemp(prefix='ais-popup-SYNTHETIC_FIXTURE-'); rid='a'*32; nonce='n'*24
with open(os.path.join(d,rid+'.json'),'w') as f: json.dump({'nonce':nonce,'command':'["fixture"]','devices':[],'reply':os.path.join(d,rid+'.sock'),'expected':'fixture-device','deadline':time.monotonic()-1},f)
m.D=d; os.environ['AIS_GUARD_REQ']=rid; os.environ['AIS_GUARD_NONCE']=nonce; sys.stdin=open('/dev/null'); out=io.StringIO(); old=sys.stdout; sys.stdout=out
try: result=m.main()
finally: sys.stdout=old
assert result==126 and 'Type exactly: fixture-device' in out.getvalue()
with open(os.path.join(d,rid+'.json'),'w') as f: json.dump({'nonce':nonce,'command':'["fixture"]','devices':[],'reply':os.path.join(d,rid+'.sock'),'expected':'fixture-device','deadline':time.monotonic()+30},f)
sys.stdin=open('/dev/null'); out=io.StringIO(); sys.stdout=out
try: result=m.main()
finally: sys.stdout=old
assert result==126 and 'Type exactly: fixture-device' in out.getvalue() and not os.path.exists(os.path.join(d,rid+'.sock'))
os.unlink(os.path.join(d,rid+'.json')); os.rmdir(d)
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('ais-pacman delegates guarded -U argv unchanged and unsafe flags never execute', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,os,sys
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('shim','image/lib/ais-pacman'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
calls=[]; m.os.execv=lambda *a:calls.append(a)
sys.argv=['ais-pacman','-U','synthetic-fixture.pkg.tar.zst']; assert m.main() is None
assert calls[-1][1]==['/usr/local/lib/ais-live/ais-guard','pacman','-U','synthetic-fixture.pkg.tar.zst']
for args in (['--config','synthetic-fixture'],['-U','https://example.invalid/pkg.pkg.tar.zst'],['-S','https://example.invalid/pkg']):
 sys.argv=['ais-pacman',*args]; before=len(calls); assert m.main()==126 and len(calls)==before
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('unsafe pacman flags and unsupported requests invoke no subprocess or root runner', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,json,os,sys,struct
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class C:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
calls=[]; m.subprocess.__dict__['run']=lambda *a,**kw:calls.append(a); m.run_root=lambda *a,**kw:calls.append(a); m.popup=lambda *a:False
for args in (['--config','synthetic-fixture'],['-S','https://example.invalid/pkg'],['-U','https://example.invalid/pkg.pkg.tar.zst']):
 c=C({'op':'pacman','argv':['pacman',*args],'cwd':'/'}); m.handle(c); assert c.sent[-1]['approved'] is False
assert calls==[]
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('read-only requests with a non-device path operand never take the root path', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, struct, sys, tempfile
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class C:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
calls=[]; m.run_root=lambda *a,**kw:(calls.append(a) or 0)
d=tempfile.mkdtemp(dir='/dev/shm' if os.path.isdir('/dev/shm') else None); f=os.path.join(d,'x'); open(f,'w').close()
for argv in (['sfdisk','-l',f],['btrfs','filesystem','show',f],['parted',f,'print']):
 c=C({'op':'disk','argv':argv,'cwd':'/'}); m.handle(c)
 assert not calls and c.sent[-1]=={'approved':True,'reason':'local'},(argv,c.sent)
for argv in (['sfdisk','-l'],['blkid'],['btrfs','filesystem','show']):
 c=C({'op':'disk','argv':argv,'cwd':'/'}); m.handle(c)
 assert len(calls)==1 and c.sent[-1]['reason']=='readonly',argv
 calls.clear()
os.unlink(f); os.rmdir(d)
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('root runs keep the checked cwd, and the popup shows the rewritten command', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, struct, sys, types
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
class C:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)]); m.rate_check=lambda u:None
m.resolve_devices=lambda n,a,c:(['if=./image.img','of=/dev/real-target'],[('/dev/link','/dev/real-target',7)])
oldstat=os.stat; os.stat=lambda p,*a,**kw:(types.SimpleNamespace(st_rdev=7) if p=='/dev/real-target' else oldstat(p,*a,**kw))
shown=[]; m.popup=lambda command,devs,expected,timeout:(shown.append(command) or True)
calls=[]; m.run_root=lambda argv,fds,devs=(),readonly_mode=False,cwd='/':(calls.append((argv,cwd)) or 0)
cwd=os.path.realpath('/usr')
c=C({'op':'disk','argv':['dd','if=./image.img','of=/dev/link'],'cwd':cwd}); m.handle(c)
assert calls[0][1]==cwd and calls[0][0]==['/usr/bin/dd','if=./image.img','of=/dev/real-target']
assert '/dev/real-target' in shown[0] and '/dev/link' not in shown[0] and cwd in shown[0],shown
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('a stalled client does not block other guarded calls', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, os, socket, sys, threading, time
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
gate=threading.Event(); done=[]
m.handle=lambda c:(gate.wait(5) if c.tag=='slow' else None, done.append(c.tag))
class Cn:
 def __init__(self,tag): self.tag=tag
 def close(self): pass
class L:
 def __init__(self): self.q=[Cn('slow'),Cn('fast')]
 def accept(self):
  if self.q: return self.q.pop(0),None
  raise KeyboardInterrupt
 def settimeout(self,x): pass
m.socket.socket=lambda fileno=None:L()
os.environ['LISTEN_PID']=str(os.getpid()); os.environ['LISTEN_FDS']='1'
m.os.geteuid=lambda:0
try: m.main()
except KeyboardInterrupt: pass
t=time.monotonic()
while 'fast' not in done and time.monotonic()-t<3: time.sleep(0.02)
assert done==['fast'],done
gate.set()
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('package name comes from an unprivileged .PKGINFO read and archives are capped', () => {
    const scratch = process.env.AIS_TEST_SCRATCH_DIR ?? tmpdir();
    const script = String.raw`
import importlib.machinery, importlib.util, io, os, shutil, sys, tarfile, tempfile
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
assert '268435456' in open('image/lib/ais-guardd').read() and '2147483648' not in open('image/lib/ais-guardd').read()
if not shutil.which('bsdtar'): sys.exit(0)
d=tempfile.mkdtemp(dir=sys.argv[1])
def pkg(name,info):
 p=os.path.join(d,name)
 with tarfile.open(p,'w') as t:
  b=info.encode(); i=tarfile.TarInfo('.PKGINFO'); i.size=len(b); t.addfile(i,io.BytesIO(b))
 return p
assert m.pkg_name(pkg('a.pkg.tar','pkgname = synthetic-fixture\npkgver = 1-1\n'))=='synthetic-fixture'
for bad in ('pkgname = a\npkgname = b\n','pkgver = 1\n','pkgname = a;b\n'):
 try: m.pkg_name(pkg('b.pkg.tar',bad))
 except ValueError: pass
 else: raise AssertionError(bad)
shutil.rmtree(d)
`;
    execFileSync('python3', ['-B', '-c', script, scratch], { cwd: join(import.meta.dir, '../..') });
  });

  test('popup requests carry a random code and discard pre-typed input', () => {
    const script = String.raw`
import importlib.machinery, importlib.util, json, os, sys, tempfile, types
sys.path.insert(0,'image/lib')
l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
seen=[]
for _ in range(2):
 d='ais-popup-code-'+str(os.getpid())+'-'+str(_); m.R=d
 m.os.chown=m.os.fchown=lambda *a:None; m.uid_for=m.gid_for=lambda n:os.getuid()
 m.pwd.getpwnam=lambda n:types.SimpleNamespace(pw_gid=os.getgid(),pw_dir='/',pw_uid=os.getuid())
 m.herdr_socket=lambda u:'/x'; m.device_info=lambda p:{'path':p}
 def run(argv,**kw):
  doc=json.load(open([os.path.join(d,f) for f in os.listdir(d) if f.endswith('.json')][0])); seen.append(doc['expected']); raise RuntimeError('stop')
 m.subprocess.__dict__['run']=run
 try: m.popup('cmd',[('/dev/a','/dev/vdb',1)],'vdb',5)
 except RuntimeError: pass
 for f in os.listdir(d): os.unlink(os.path.join(d,f))
 os.rmdir(d)
assert all(x.startswith('vdb ') and len(x)==8 for x in seen) and seen[0]!=seen[1],seen
# pop-up pane: sleeps, then flushes the tty input queue before reading
import importlib
pl=importlib.machinery.SourceFileLoader('pop','image/lib/ais-guard-popup'); ps=importlib.util.spec_from_loader(pl.name,pl); p=importlib.util.module_from_spec(ps); pl.exec_module(p)
order=[]; p.time.sleep=lambda x:order.append(('sleep',x)); p.termios.tcflush=lambda fd,q:order.append(('flush',q))
d=tempfile.mkdtemp(); p.D=d; rid='b'*32
json.dump({'nonce':'n'*24,'command':'x','devices':[],'reply':os.path.join(d,rid+'.sock'),'expected':'vdb ab12','deadline':p.time.monotonic()+30},open(os.path.join(d,rid+'.json'),'w'))
os.environ['AIS_GUARD_REQ']=rid; os.environ['AIS_GUARD_NONCE']='n'*24; sys.stdin=open('/dev/null'); so=sys.stdout; sys.stdout=open(os.devnull,'w')
try: p.main()
finally: sys.stdout=so
assert order[0][0]=='sleep' and order[0][1]>=1 and order[1]==('flush',p.termios.TCIFLUSH),order
os.unlink(os.path.join(d,rid+'.json')); os.rmdir(d)
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('client execs the real binary with the original argv when the daemon replies local', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,json,os,socket,sys,tempfile,threading
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('cl','image/lib/ais-guard'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
path='ais-client-'+str(os.getpid())+'.sock'
srv=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); srv.bind(path); srv.listen(1)
def serve():
 c,_=srv.accept(); c.recvmsg(4096,64); c.sendall(b'{"approved":true,"reason":"local"}\n'); c.close()
t=threading.Thread(target=serve); t.start()
os.environ['AIS_GUARD_SOCKET']=path; calls=[]; m.os.execv=lambda *a:calls.append(a)
sys.argv=['/usr/local/guard/bin/dd','if=./x','of=./y']; m.main(); t.join()
assert calls==[('/usr/bin/dd',['dd','if=./x','of=./y'])],calls
srv.close(); os.unlink(path)
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('approvals are serialised: one popup at a time, and rate checks are thread safe', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,sys,threading,time
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
live=[0]; peak=[0]; lk=threading.Lock()
def fake(*a):
 with lk: live[0]+=1; peak[0]=max(peak[0],live[0])
 time.sleep(0.1)
 with lk: live[0]-=1
 return True
m._popup=fake
ts=[threading.Thread(target=m.popup,args=('c',[],'e',5)) for _ in range(4)]
[t.start() for t in ts]; [t.join() for t in ts]
assert peak[0]==1,peak
m.RATE.clear(); ok=[]; bad=[]
def hit():
 try: m.rate_check(7); ok.append(1)
 except ValueError: bad.append(1)
orig=m.time.monotonic
ts=[threading.Thread(target=hit) for _ in range(7)]
[t.start() for t in ts]; [t.join() for t in ts]
assert len(ok)==6 and len(bad)==1,(ok,bad)
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('sandbox profiles are per tool, /tmp cwd is refused, and pacman never reads stdin', () => {
    const script = String.raw`
import importlib.machinery,importlib.util,json,os,struct,sys,types
sys.path.insert(0,'image/lib'); l=importlib.machinery.SourceFileLoader('g','image/lib/ais-guardd'); s=importlib.util.spec_from_loader(l.name,l); m=importlib.util.module_from_spec(s); l.exec_module(m)
for n in ('mdadm','cryptsetup','lvcreate','dd','blkid'):
 for ro in (False,True):
  p=m.sandbox_props(n,ro)
  assert 'NoExecPaths=/' in p and 'ExecPaths=/usr' in p and 'ProtectKernelModules=yes' in p and 'ProtectSystem=strict' in p,(n,p)
md=m.sandbox_props('mdadm'); assert 'ProtectKernelTunables=yes' not in md and 'DeviceAllow=/dev/md* rw' in md
for n in ('cryptsetup','lvcreate','lvm','dmsetup'):
 p=m.sandbox_props(n); assert 'DeviceAllow=/dev/mapper/control rw' in p and 'ProtectKernelTunables=yes' in p
 assert any('/run/cryptsetup' in x and '/run/lock/lvm' in x for x in p if x.startswith('ReadWritePaths=')),n
assert 'ProtectKernelTunables=yes' in m.sandbox_props('dd') and not any(x.startswith('ReadWritePaths') for x in m.sandbox_props('dd'))
class C:
 def __init__(self,req): self.req=req; self.sent=[]
 def settimeout(self,x): pass
 def getsockopt(self,*a): return struct.pack('3i',1,os.getuid(),os.getgid())
 def sendall(self,b): self.sent.append(json.loads(b))
 def close(self): pass
m.uid_for=lambda n:os.getuid(); m.recv_req=lambda c:(c.req,[os.dup(0),os.dup(1),os.dup(2)])
m.resolve_devices=lambda n,a,c:(a,[('/dev/fake','/dev/fake',5)]); calls=[]
m.popup=lambda *a:(calls.append(a) or True); m.run_root=lambda *a,**k:calls.append(a)
os.makedirs('/tmp/ais-cwd-probe',exist_ok=True)
c=C({'op':'disk','argv':['dd','of=/dev/fake'],'cwd':'/tmp/ais-cwd-probe'}); m.handle(c)
os.rmdir('/tmp/ais-cwd-probe')
assert not calls and c.sent[-1]['approved'] is False and '/tmp' in c.sent[-1]['reason'],c.sent
runs=[]
class R: returncode=0
m.subprocess.__dict__['run']=lambda argv,**kw:(runs.append((argv,kw)) or R())
for args in (['-Q'],['-S','synthetic-fixture']):
 c=C({'op':'pacman','argv':['pacman',*args],'cwd':'/'}); m.handle(c)
assert len(runs)==2 and all(kw['stdin']==m.subprocess.DEVNULL and kw.get('timeout') for _,kw in runs),runs
assert 'RuntimeMaxSec=1800' in runs[1][0]
`;
    execFileSync('python3', ['-B', '-c', script], { cwd: join(import.meta.dir, '../..') });
  });

  test('package handling is one at a time and bsdtar is bounded', () => {
    const src = readFileSync(join(root, 'ais-guardd'), 'utf8');
    expect(src).toContain('with PKG_LOCK:');
    expect(src).toContain('threading.Timer(30,p.kill)');
  });

  test('the confirmation opens focused so typed keys reach it, not the agent pane', () => {
    expect(daemon).toContain("'--placement','overlay','--focus'");
  });

  test('all listed commands have executable PATH wrapper links wired by image profile', () => {
    expect(readFileSync(join(root, 'ais-guard-table'), 'utf8')).toContain('dd destructive');
  });
});
