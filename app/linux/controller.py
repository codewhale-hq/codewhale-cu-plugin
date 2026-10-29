import ctypes
import json
import os
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading

if len(sys.argv) > 2 and sys.argv[1] == '--parent-bound-auth':
    expected = int(sys.argv[2])
    libc = ctypes.CDLL(None, use_errno=True)
    if os.getppid() != expected or libc.prctl(1, signal.SIGTERM, 0, 0, 0) != 0 or os.getppid() != expected:
        os._exit(125)
    os.execv(sys.argv[3], sys.argv[3:])

ACTION = 'net.codewhale.computer-use.approve'
POLICY_NAME = 'net.codewhale.computer-use.policy'
POLICY = '/usr/share/polkit-1/actions/' + POLICY_NAME
EXPECTED = os.path.join(os.path.dirname(os.path.realpath(__file__)), POLICY_NAME)

def trusted_binary(name):
    candidate = shutil.which(name)
    if not candidate:
        return None
    try:
        path = os.path.realpath(candidate)
        info = os.stat(path)
        if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or not os.access(path, os.X_OK):
            return None
        return path
    except OSError:
        return None

def policy_ready():
    if os.getuid() == 0:
        return False
    try:
        fd = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            info = os.fstat(fd)
            if info.st_uid != 0 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o022 or info.st_size > 65536:
                return False
            actual = os.read(fd, 65537)
        finally:
            os.close(fd)
        if actual != open(EXPECTED, 'rb').read(65537):
            return False
        action = trusted_binary('pkaction')
        if not action or not trusted_binary('pkcheck'):
            return False
        return subprocess.run([action, '--action-id', ACTION], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False

def session_ready():
    session = ctypes.c_void_p()
    seat = ctypes.c_void_p()
    try:
        systemd = ctypes.CDLL('libsystemd.so.0')
        libc = ctypes.CDLL(None)
        systemd.sd_pid_get_session.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
        systemd.sd_pid_get_session.restype = ctypes.c_int
        systemd.sd_session_is_active.argtypes = [ctypes.c_char_p]
        systemd.sd_session_is_active.restype = ctypes.c_int
        systemd.sd_session_is_remote.argtypes = [ctypes.c_char_p]
        systemd.sd_session_is_remote.restype = ctypes.c_int
        systemd.sd_session_get_uid.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_uint)]
        systemd.sd_session_get_uid.restype = ctypes.c_int
        systemd.sd_session_get_seat.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
        systemd.sd_session_get_seat.restype = ctypes.c_int
        libc.free.argtypes = [ctypes.c_void_p]
        if systemd.sd_pid_get_session(os.getpid(), ctypes.byref(session)) < 0 or not session.value:
            return False
        value = ctypes.cast(session, ctypes.c_char_p)
        uid = ctypes.c_uint()
        return (systemd.sd_session_get_uid(value, ctypes.byref(uid)) >= 0 and uid.value == os.getuid()
                and systemd.sd_session_get_seat(value, ctypes.byref(seat)) >= 0 and bool(seat.value)
                and systemd.sd_session_is_active(value) > 0 and systemd.sd_session_is_remote(value) == 0)
    except (AttributeError, OSError):
        return False
    finally:
        if seat.value:
            libc.free(seat)
        if session.value:
            libc.free(session)

node, daemon = sys.argv[1:3]
parent, child = socket.socketpair()
def child_setup():
    os.dup2(child.fileno(), 3, inheritable=True)
    if child.fileno() != 3:
        os.close(child.fileno())
env = dict(os.environ, CODEWHALE_CU_CONTROL_FD='3')
proc = subprocess.Popen([node, daemon], env=env, pass_fds=(3, child.fileno()), preexec_fn=child_setup)
child.close()

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gdk, GLib, Gtk

class Panel:
    def __init__(self):
        self.control = parent
        self.buf = b''
        self.pending = None
        self.cancel = None
        self.dialog = None
        self.auth = None
        self.minimize_approval = None
        self.minimize_timeout = None
        self.lock = threading.Lock()
        self.mode = 'connecting'
        self.available = policy_ready()
        self.window = Gtk.Window(title='Computer Use')
        self.window.set_default_size(430, 180)
        self.window.set_focus_on_map(False)
        self.window.connect('delete-event', self.close)
        self.window.connect('window-state-event', self.window_state)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, margin=20)
        self.window.add(box)
        header = Gtk.Box(spacing=14)
        bundle = os.environ.get('CODEWHALE_CU_APP_BUNDLE', '')
        icon_path = os.path.join(bundle, 'share', 'icons', 'hicolor', '48x48', 'apps', 'net.codewhale.computer-use.png')
        if os.path.isfile(icon_path):
            try: self.window.set_icon_from_file(icon_path)
            except Exception: pass
            header.pack_start(Gtk.Image.new_from_file(icon_path), False, False, 0)
        heading = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=3)
        title = Gtk.Label(label='Computer Use', xalign=0)
        title.get_style_context().add_class('title')
        heading.pack_start(title, False, False, 0)
        heading.pack_start(Gtk.Label(label='By Codewhale', xalign=0), False, False, 0)
        header.pack_start(heading, False, False, 0)
        box.pack_start(header, False, False, 0)
        self.status = Gtk.Label(label='Connecting to helper…', xalign=0)
        self.status.set_line_wrap(True)
        box.pack_start(self.status, False, False, 0)
        self.notice = Gtk.Label(label='' if self.available else 'Set up Linux approval using the installation guide, then quit and reopen Computer Use.', xalign=0)
        self.notice.set_line_wrap(True)
        box.pack_start(self.notice, False, False, 0)
        buttons = Gtk.Box(spacing=8)
        box.pack_start(buttons, False, False, 0)
        self.pause = Gtk.Button(label='Pause')
        self.pause.connect('clicked', self.toggle)
        buttons.pack_start(self.pause, False, False, 0)
        self.stop = Gtk.Button(label='Stop computer use')
        self.stop.connect('clicked', lambda *_: self.send({'command':'stop'}))
        buttons.pack_start(self.stop, False, False, 0)
        done = Gtk.Button(label='Quit')
        done.connect('clicked', self.close)
        buttons.pack_start(done, False, False, 0)
        self.window.show_all()
        GLib.io_add_watch(self.control.fileno(), GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, self.read)
        if self.available:
            self.send({'command':'capabilities','consent':1})
        self.send({'command':'status'})
    def send(self, obj):
        try:
            self.control.sendall((json.dumps(obj)+'\n').encode())
        except OSError:
            self.close()
    def toggle(self, *_):
        self.send({'command':'pause' if self.mode == 'ready' else 'resume'})
    def cancel_auth(self):
        if self.cancel:
            self.cancel.set()
        self.minimize_approval = None
        if self.minimize_timeout is not None:
            GLib.source_remove(self.minimize_timeout)
            self.minimize_timeout = None
        with self.lock:
            auth = self.auth
        if auth:
            try: auth.terminate()
            except ProcessLookupError: pass
    def close(self, *_):
        self.cancel_auth()
        try: self.control.sendall(b'{"command":"stop"}\n')
        except OSError: pass
        self.control.close()
        Gtk.main_quit()
        return False
    def read(self, fd, condition):
        if condition & (GLib.IO_HUP | GLib.IO_ERR | GLib.IO_NVAL):
            return self.disconnected()
        try: chunk = self.control.recv(65536)
        except OSError: return self.disconnected()
        if not chunk: return self.disconnected()
        self.buf += chunk
        if len(self.buf) > 262144:
            self.close()
            return False
        while b'\n' in self.buf:
            line, self.buf = self.buf.split(b'\n', 1)
            try: state = json.loads(line)
            except ValueError: continue
            self.update(state)
        return True
    def disconnected(self):
        self.cancel_auth()
        self.pending = None
        self.cancel = None
        if self.dialog:
            self.dialog.destroy()
            self.dialog = None
        self.status.set_text('Helper disconnected; computer use is stopped.')
        self.pause.set_sensitive(False)
        self.stop.set_sensitive(False)
        return False
    def update(self, state):
        self.mode = state.get('mode', 'connecting')
        self.status.set_text({'ready':'Ready', 'paused':'Computer use is paused', 'stopped':'Computer use is stopped'}.get(self.mode, 'Connecting to helper…'))
        self.pause.set_label('Pause' if self.mode == 'ready' else 'Resume')
        self.pause.set_sensitive(self.mode in ('ready', 'paused', 'stopped') and not state.get('cleanupPending'))
        prompt = state.get('consent')
        if self.pending and (not prompt or prompt.get('id') != self.pending):
            self.cancel_auth()
            self.pending = None
            self.cancel = None
            if self.dialog:
                self.dialog.destroy()
                self.dialog = None
        if prompt and not self.pending:
            self.prompt(prompt)
    def prompt(self, prompt):
        self.pending = prompt['id']
        self.cancel = threading.Event()
        reason = prompt.get('reason', '')
        if not (reason.startswith('approve Computer Use access to ') or reason == 'approve Computer Use foreground control'):
            self.send({'command':'consent_decision','consent':self.pending,'decision':'deny','auth':'unsupported'})
            return
        self.window.deiconify()
        dialog = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.QUESTION, buttons=Gtk.ButtonsType.NONE, text=prompt.get('headline','Computer Use asks for access'))
        dialog.set_title('Computer Use approval')
        dialog.format_secondary_text('\n'.join(prompt.get('lines',[]))+'\n\nContinue to authenticate, or deny this request.')
        dialog.add_button('Deny', Gtk.ResponseType.CANCEL)
        dialog.add_button('Continue', Gtk.ResponseType.OK)
        dialog.set_default_response(Gtk.ResponseType.CANCEL)
        dialog.connect('response', self.reply, prompt['id'], self.cancel)
        self.dialog = dialog
        dialog.show_all()
        dialog.present()
    def reply(self, dialog, response, prompt_id, cancel):
        if self.pending != prompt_id or self.cancel is not cancel:
            return
        if response != Gtk.ResponseType.OK:
            self.cancel_auth()
            self.send({'command':'consent_decision','consent':prompt_id,'decision':'deny','auth':'none'})
            dialog.destroy()
            self.dialog = None
            return
        dialog.set_response_sensitive(Gtk.ResponseType.OK, False)
        threading.Thread(target=self.authenticate, args=(prompt_id,cancel), daemon=True).start()
    def authenticate(self, prompt_id, cancel):
        auth = None
        ok = False
        try:
            executable = trusted_binary('pkcheck')
            if not executable or not policy_ready() or not session_ready():
                raise RuntimeError('policy unavailable')
            pid=os.getpid()
            start=open('/proc/%d/stat' % pid).read().rsplit(')',1)[1].split()[19]
            subject='%d,%s,%d' % (pid,start,os.getuid())
            base=[executable,'--action-id',ACTION,'--process',subject]
            check=subprocess.run(base,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
            if check.returncode != 2 or cancel.is_set():
                raise RuntimeError('fresh authentication unavailable')
            auth=subprocess.Popen([sys.executable, os.path.realpath(__file__), '--parent-bound-auth', str(os.getpid()), *base, '--allow-user-interaction'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            with self.lock:
                if cancel.is_set():
                    auth.terminate()
                else:
                    self.auth=auth
            if auth.wait(timeout=100)==0 and not cancel.is_set() and session_ready() and policy_ready():
                after=subprocess.run(base,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
                ok=after.returncode==2 and session_ready()
        except (OSError, RuntimeError, subprocess.SubprocessError):
            if auth:
                try: auth.terminate()
                except ProcessLookupError: pass
        finally:
            with self.lock:
                if self.auth is auth:
                    self.auth=None
        if not cancel.is_set():
            GLib.idle_add(self.finish, prompt_id, cancel, ok)
    def finish(self, prompt_id, cancel, ok):
        if self.pending != prompt_id or self.cancel is not cancel or cancel.is_set():
            return False
        if self.dialog:
            self.dialog.destroy()
            self.dialog=None
        if not ok:
            self.notice.set_text('Authentication was canceled or unavailable. Check the system approval setup.')
            self.send({'command':'consent_decision','consent':prompt_id,'decision':'deny','auth':'unavailable'})
            return False
        self.minimize_approval = (prompt_id, cancel)
        self.minimize_timeout = GLib.timeout_add(2000, self.minimize_failed)
        self.window.iconify()
        window = self.window.get_window()
        if window and window.get_state() & Gdk.WindowState.ICONIFIED:
            self.finish_minimize()
        return False
    def window_state(self, window, event):
        if event.new_window_state & Gdk.WindowState.ICONIFIED:
            self.finish_minimize()
        return False
    def finish_minimize(self):
        approval = self.minimize_approval
        if not approval:
            return
        self.minimize_approval = None
        if self.minimize_timeout is not None:
            GLib.source_remove(self.minimize_timeout)
            self.minimize_timeout = None
        prompt_id, cancel = approval
        if self.pending == prompt_id and self.cancel is cancel and not cancel.is_set():
            self.send({'command':'consent_decision','consent':prompt_id,'decision':'allow','auth':'local'})
    def minimize_failed(self):
        approval = self.minimize_approval
        self.minimize_approval = None
        self.minimize_timeout = None
        if approval:
            prompt_id, cancel = approval
            if self.pending == prompt_id and self.cancel is cancel and not cancel.is_set():
                self.notice.set_text('The desktop could not minimize Computer Use. Check your window manager and retry.')
                self.send({'command':'consent_decision','consent':prompt_id,'decision':'deny','auth':'unavailable'})
        return False

Panel()
Gtk.main()
