import ctypes
import fcntl
import json
import os
import re
import signal
import stat
import subprocess
import sys
import threading

stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
signal.signal(signal.SIGINT, lambda *_: stop.set())
payload = json.loads(sys.stdin.buffer.readline())
text, window = payload['text'], int(payload['window'], 16)

def watch():
    sys.stdin.buffer.read()
    stop.set()
threading.Thread(target=watch, daemon=True).start()

def check():
    if stop.is_set():
        raise RuntimeError('cancelled')

def command(args, cleanup=False):
    if not cleanup:
        check()
    result = subprocess.run(args, capture_output=True, text=True, timeout=5, check=False)
    if result.returncode != 0:
        raise RuntimeError('x11_input_failed')
    return result.stdout

def mappings(cleanup=False):
    return {int(key): value.strip() for key, value in re.findall(r'^keycode\s+(\d+)\s*=(.*)$', command(['xmodmap', '-pke'], cleanup=cleanup), re.M)}

def wait(seconds):
    if stop.wait(seconds):
        raise RuntimeError('cancelled')

def owner():
    if int(command(['xdotool', 'getactivewindow']).strip()) != window:
        raise RuntimeError('input_owner_changed')

lock_path = os.path.join('/tmp', 'codewhale-x11-' + str(os.getuid()) + '.lock')
lock = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
info = os.fstat(lock)
if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
    raise RuntimeError('unsafe_lock_file')

xlib = ctypes.CDLL('libX11.so.6')
xlib.XStringToKeysym.argtypes = [ctypes.c_char_p]
xlib.XStringToKeysym.restype = ctypes.c_ulong
spare = None
expected = None
sent = False
error = None
try:
    while True:
        check()
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            wait(0.05)
    empty = [k for k, v in mappings().items() if not v]
    if not empty:
        raise RuntimeError('x11_keymap_unavailable')
    spare = empty[0]
    chunks, ascii_run = [], ''
    for char in text:
        if ord(char) > 127:
            if ascii_run:
                chunks.append(ascii_run)
                ascii_run = ''
            chunks.append(char)
        else:
            ascii_run += char
            if len(ascii_run) == 8:
                chunks.append(ascii_run)
                ascii_run = ''
    if ascii_run:
        chunks.append(ascii_run)
    for chunk in chunks:
        owner()
        if ord(chunk[0]) <= 127:
            sent = True
            command(['xdotool', 'type', '--delay', '12', '--', chunk])
            continue
        current = mappings().get(spare)
        if current != (expected or ''):
            raise RuntimeError('x11_keymap_changed')
        symbol = 'U' + format(ord(chunk), '04X')
        command(['xmodmap', '-e', 'keycode ' + str(spare) + ' = ' + symbol])
        expected = mappings().get(spare)
        target = xlib.XStringToKeysym(symbol.encode())
        if not expected or not target or target not in [xlib.XStringToKeysym(token.encode()) for token in expected.split()]:
            expected = None
            raise RuntimeError('x11_keymap_changed')
        wait(0.1)
        owner()
        sent = True
        shift = 'shift+' if chunk != chunk.lower() else ''
        command(['xdotool', 'key', shift + symbol])
        wait(0.2)
except Exception as exc:
    error = str(exc) if isinstance(exc, RuntimeError) else 'x11_input_failed'
finally:
    if spare is not None and expected is not None:
        try:
            if mappings(cleanup=True).get(spare) == expected:
                command(['xmodmap', '-e', 'keycode ' + str(spare) + ' ='], cleanup=True)
                if mappings(cleanup=True).get(spare) != '':
                    error = error or 'x11_keymap_cleanup_failed'
            else:
                error = error or 'x11_keymap_changed'
        except Exception:
            error = error or 'x11_keymap_cleanup_failed'
    os.close(lock)

print(json.dumps({'ok': error is None, 'error': error, 'action_sent': sent}), flush=True)
