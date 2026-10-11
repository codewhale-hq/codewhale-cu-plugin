#!/usr/bin/env python3
"""Wayland virtual keyboard and pointer for Codewhale Computer Use (stdlib only).

Speaks the Wayland wire protocol directly: zwp_virtual_keyboard_v1 with the
session's own XKB keymap (compiled by libxkbcommon from the XKB_DEFAULT_*
environment, as the compositor does), and zwlr_virtual_pointer_v1. One JSON
request per stdin line; each reply is written only after a wl_display.sync
round trip, so the compositor has processed every event before the caller
hears "ok". Keys and buttons still pressed when stdin closes are released
before exit.

Request: {"steps": [step, ...]}
  ["key", keysym_name, 1|0]       press or release; keysyms the layout puts on
                                  the shift level press Shift around them
  ["sleep", ms]
  ["move", x, y, x_extent, y_extent]
  ["button", linux_button_code, 1|0]
  ["axis", axis, value, discrete]
  ["text", string]                type the string; characters the layout has no
                                  key for go through a temporary keymap that
                                  lends them keys the string does not use
Reply: {"ok": true} or {"ok": false, "code": ..., "message": ...}
"""
import ctypes, ctypes.util, json, os, select, socket, struct, sys, tempfile, time

# Seconds a client gets to load a keymap before the first key that needs it.
SETTLE = 0.06

class WaylandError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code

# ---------- libxkbcommon ----------
_xkb_path = ctypes.util.find_library("xkbcommon") or "libxkbcommon.so.0"
try:
    xkb = ctypes.CDLL(_xkb_path)
except OSError:
    xkb = None

def _sig(name, res, *args):
    f = getattr(xkb, name)
    f.restype = res
    f.argtypes = list(args)
    return f

class Keymap:
    """A compiled XKB keymap and a keysym -> (keycode, level) index of its first two levels."""
    def __init__(self, text=None):
        if xkb is None:
            raise WaylandError("no_xkbcommon", "libxkbcommon is not installed")
        vp, u32, i32 = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
        _sig("xkb_context_new", vp, i32)
        _sig("xkb_keymap_new_from_names", vp, vp, vp, i32)
        _sig("xkb_keymap_new_from_string", vp, vp, ctypes.c_char_p, i32, i32)
        _sig("xkb_keymap_get_as_string", ctypes.c_void_p, vp, i32)
        _sig("xkb_keymap_min_keycode", u32, vp)
        _sig("xkb_keymap_max_keycode", u32, vp)
        _sig("xkb_keymap_num_levels_for_key", u32, vp, u32, u32)
        _sig("xkb_keymap_key_get_syms_by_level", i32, vp, u32, u32, u32, ctypes.POINTER(ctypes.POINTER(u32)))
        _sig("xkb_keymap_key_get_name", ctypes.c_char_p, vp, u32)
        _sig("xkb_keysym_from_name", u32, ctypes.c_char_p, i32)
        _sig("xkb_keysym_get_name", i32, u32, ctypes.c_char_p, ctypes.c_size_t)
        _sig("xkb_utf32_to_keysym", u32, u32)
        _sig("xkb_state_new", vp, vp)
        _sig("xkb_state_update_key", i32, vp, u32, i32)
        _sig("xkb_state_serialize_mods", u32, vp, i32)
        _sig("xkb_state_serialize_layout", u32, vp, i32)
        ctx = xkb.xkb_context_new(0)
        if not ctx:
            self.keymap = None
        elif text is None:
            self.keymap = xkb.xkb_keymap_new_from_names(ctx, None, 0)
        else:
            self.keymap = xkb.xkb_keymap_new_from_string(ctx, text, 1, 0)
        if not self.keymap:
            raise WaylandError("keymap_failed", "libxkbcommon could not compile the session keymap (check XKB_DEFAULT_LAYOUT)")
        self.text = ctypes.string_at(xkb.xkb_keymap_get_as_string(self.keymap, 1))
        self.state = xkb.xkb_state_new(self.keymap)
        self.index = {}
        self.syms_of = {}
        for kc in range(xkb.xkb_keymap_min_keycode(self.keymap), xkb.xkb_keymap_max_keycode(self.keymap) + 1):
            for level in range(min(2, xkb.xkb_keymap_num_levels_for_key(self.keymap, kc, 0))):
                syms = ctypes.POINTER(ctypes.c_uint32)()
                for i in range(xkb.xkb_keymap_key_get_syms_by_level(self.keymap, kc, 0, level, ctypes.byref(syms))):
                    self.index.setdefault(syms[i], (kc, level))
                    self.syms_of.setdefault(kc, set()).add(syms[i])
        # Character keys of the main block. Toolkits treat these keycodes as
        # ordinary keys, so a temporary keymap can lend them other characters;
        # unassigned keycodes map to IME and media keys some toolkits swallow.
        self.lendable = sorted(kc for kc, syms in self.syms_of.items() if kc <= 255 and any(0x21 <= x <= 0x7e for x in syms))

    def lookup(self, name):
        sym = xkb.xkb_keysym_from_name(name.encode(), 0) or xkb.xkb_keysym_from_name(name.encode(), 1)
        hit = self.index.get(sym) if sym else None
        if hit is None:
            raise WaylandError("unknown_key", f'the keyboard layout has no key for "{name}"')
        return hit

    @staticmethod
    def char_sym(ch):
        named = {"\n": "Return", "\r": "Return", "\t": "Tab"}.get(ch)
        if named:
            return xkb.xkb_keysym_from_name(named.encode(), 0)
        return xkb.xkb_utf32_to_keysym(ord(ch))

    def char(self, ch):
        sym = self.char_sym(ch)
        return self.index.get(sym) if sym else None

    def lenders(self, text):
        """Character keys free to lend: none of their symbols is typed in `text`."""
        used = {self.char_sym(ch) for ch in text}
        return [kc for kc in self.lendable if not self.syms_of[kc] & used]

    def augmented(self, chars, text):
        """This keymap with one character key per character it has no key for, lent by a key `text` does not use."""
        free = self.lenders(text)
        if len(chars) > len(free):
            raise WaylandError("unknown_key", "too many characters outside the keyboard layout in one request")
        lines = []
        for ch, kc in zip(chars, free):
            sym = self.char_sym(ch)
            buf = ctypes.create_string_buffer(64)
            if not sym or xkb.xkb_keysym_get_name(sym, buf, 64) <= 0:
                raise WaylandError("unknown_key", f"no keysym for {ch!r}")
            lines.append(b'\tkey <%s> { type= "ONE_LEVEL", symbols[Group1] = [ %s ] };\n' % (xkb.xkb_keymap_key_get_name(self.keymap, kc), buf.value))
        start = self.text.index(b"xkb_symbols")
        end = self.text.index(b"\n};", start)
        return Keymap(self.text[:end + 1] + b"".join(lines) + self.text[end + 1:])

    def update(self, kc, down):
        xkb.xkb_state_update_key(self.state, kc, 1 if down else 0)
        return [xkb.xkb_state_serialize_mods(self.state, m) for m in (1, 2, 4)] + [xkb.xkb_state_serialize_layout(self.state, 0x80)]

    def mods(self):
        return [xkb.xkb_state_serialize_mods(self.state, m) for m in (1, 2, 4)] + [xkb.xkb_state_serialize_layout(self.state, 0x80)]

# ---------- Wayland wire protocol ----------
def _socket_path():
    name = os.environ.get("WAYLAND_DISPLAY") or "wayland-0"
    if os.path.isabs(name):
        return name
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime:
        raise WaylandError("no_session", "XDG_RUNTIME_DIR is not set")
    return os.path.join(runtime, name)

def _string(s):
    b = s.encode() + b"\0"
    return struct.pack("<I", len(b)) + b + b"\0" * (-len(b) % 4)

class Connection:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.connect(_socket_path())
        except OSError as e:
            raise WaylandError("no_session", f"cannot connect to the Wayland socket: {e}")
        self.next_id = 2
        self.buf = b""
        self.globals = {}
        self.done = set()

    def new_id(self):
        i = self.next_id
        self.next_id += 1
        return i

    def send(self, obj, opcode, payload=b"", fds=()):
        msg = struct.pack("<II", obj, ((8 + len(payload)) << 16) | opcode) + payload
        if fds:
            self.sock.sendmsg([msg], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, struct.pack("<%di" % len(fds), *fds))])
        else:
            self.sock.sendall(msg)

    def read_events(self):
        data = self.sock.recv(65536)
        if not data:
            raise WaylandError("compositor_gone", "the compositor closed the connection")
        self.buf += data
        while len(self.buf) >= 8:
            obj, word = struct.unpack_from("<II", self.buf)
            size, opcode = word >> 16, word & 0xFFFF
            if len(self.buf) < size:
                break
            body, self.buf = self.buf[8:size], self.buf[size:]
            self.event(obj, opcode, body)

    def event(self, obj, opcode, body):
        if obj == 1 and opcode == 0:  # wl_display.error
            oid, code, n = struct.unpack_from("<III", body)
            raise WaylandError("protocol_error", f"compositor error on object {oid} code {code}: {body[12:12 + n - 1].decode(errors='replace')}")
        if obj == 2 and opcode == 0:  # wl_registry.global
            name, n = struct.unpack_from("<II", body)
            iface = body[8:8 + n - 1].decode()
            version = struct.unpack_from("<I", body, 8 + n + (-n % 4))[0]
            self.globals.setdefault(iface, (name, version))
        elif obj in self.callbacks and opcode == 0:  # wl_callback.done
            self.done.add(obj)
        elif obj in self.listeners:
            self.listeners[obj](opcode, body)

    callbacks = set()
    listeners = {}

    def roundtrip(self, timeout=5.0):
        cb = self.new_id()
        self.callbacks.add(cb)
        self.send(1, 0, struct.pack("<I", cb))  # wl_display.sync
        deadline = time.monotonic() + timeout
        while cb not in self.done:
            left = deadline - time.monotonic()
            if left <= 0 or not select.select([self.sock], [], [], left)[0]:
                raise WaylandError("compositor_timeout", "the compositor did not answer within %.0fs" % timeout)
            self.read_events()

    def bind(self, iface, version):
        if iface not in self.globals:
            return None
        name, have = self.globals[iface]
        oid = self.new_id()
        self.send(2, 0, struct.pack("<I", name) + _string(iface) + struct.pack("<II", min(version, have), oid))
        return oid

class Devices:
    def __init__(self):
        self.conn = Connection()
        self.conn.send(1, 1, struct.pack("<I", self.conn.new_id()))  # wl_display.get_registry -> 2
        self.conn.roundtrip()
        self.seat = self.conn.bind("wl_seat", 1)
        if self.seat is None:
            raise WaylandError("no_seat", "the compositor has no wl_seat")
        self.caps = 0
        self.conn.listeners[self.seat] = self.seat_event
        self.conn.roundtrip()
        self.keyboard = None
        self.keymap = None
        self.activated = False
        self.pointer = None
        self.keys = {}  # keycode -> True while pressed
        self.buttons = set()
        self.t0 = time.monotonic()

    def seat_event(self, opcode, body):
        if opcode == 0:  # wl_seat.capabilities
            self.caps = struct.unpack_from("<I", body)[0]

    def await_capability(self, bit, had):
        """A seat that gains a pointer or keyboard only now (a headless session)
        tells clients asynchronously; events before they bind it are lost."""
        if had:
            return
        deadline = time.monotonic() + 2
        while not self.caps & bit and time.monotonic() < deadline:
            self.conn.roundtrip()
        time.sleep(0.3)

    def now(self):
        return int((time.monotonic() - self.t0) * 1000) & 0xFFFFFFFF

    def ensure_keyboard(self):
        if self.keyboard:
            return
        mgr = self.conn.bind("zwp_virtual_keyboard_manager_v1", 1)
        if mgr is None:
            raise WaylandError("no_virtual_keyboard", "the compositor does not offer zwp_virtual_keyboard_manager_v1 (wlroots compositors do; GNOME and KDE do not)")
        self.base = Keymap()
        had = self.caps & 2
        self.keyboard = self.conn.new_id()
        self.conn.send(mgr, 0, struct.pack("<II", self.seat, self.keyboard))
        self.upload(self.base)
        self.await_capability(2, had)

    def upload(self, keymap):
        text = keymap.text + b"\0"
        fd, path = tempfile.mkstemp(prefix="cu-keymap-")
        try:
            os.unlink(path)
            os.write(fd, text)
            self.conn.send(self.keyboard, 0, struct.pack("<II", 1, len(text)), fds=(fd,))  # keymap(format xkb_v1, fd, size)
            self.conn.roundtrip()
        finally:
            os.close(fd)
        self.keymap = keymap

    def activate(self):
        """Make this the seat's active keyboard before any key.

        The compositor hands a keyboard's keymap to the focused client only
        when that keyboard becomes active, and clients apply it
        asynchronously: a key sent in the same burst is read against the
        previous keymap (GTK drops it, X clients through XWayland see another
        key). A modifiers change activates the keyboard without a key; the
        pause lets the client load the keymap first.
        """
        shift = 1 << 0
        mods = self.keymap.mods()
        self.conn.send(self.keyboard, 2, struct.pack("<IIII", mods[0] ^ shift, *mods[1:]))
        self.conn.send(self.keyboard, 2, struct.pack("<IIII", *mods))
        self.conn.roundtrip()
        time.sleep(SETTLE)
        self.activated = True

    def ensure_pointer(self):
        if self.pointer:
            return
        mgr = self.conn.bind("zwlr_virtual_pointer_manager_v1", 2)
        self.pointer_version = min(2, self.conn.globals.get("zwlr_virtual_pointer_manager_v1", (0, 1))[1])
        if mgr is None:
            raise WaylandError("no_virtual_pointer", "the compositor does not offer zwlr_virtual_pointer_manager_v1 (wlroots compositors do; GNOME and KDE do not)")
        had = self.caps & 1
        ptr = self.conn.new_id()
        self.conn.send(mgr, 0, struct.pack("<II", self.seat, ptr))
        self.pointer = ptr
        self.await_capability(1, had)

    def key(self, kc, down):
        self.conn.send(self.keyboard, 1, struct.pack("<III", self.now(), kc - 8, 1 if down else 0))
        mods = self.keymap.update(kc, down)
        self.conn.send(self.keyboard, 2, struct.pack("<IIII", *mods))
        if down:
            self.keys[kc] = True
        else:
            self.keys.pop(kc, None)

    def stroke(self, kc, level):
        shift = self.keymap.lookup("Shift_L")[0] if level == 1 else None
        if shift:
            self.key(shift, True)
        self.key(kc, True)
        self.key(kc, False)
        if shift:
            self.key(shift, False)

    def step(self, s):
        op = s[0]
        if op == "text":
            self.ensure_keyboard()
            # Segments in order; each one's characters outside the layout fit
            # the keys it leaves free for one augmented keymap.
            segments, seg, extra = [], "", set()
            for ch in str(s[1]):
                grown = extra | ({ch} if self.base.char(ch) is None else set())
                if seg and len(grown) > len(self.base.lenders(seg + ch)):
                    segments.append((seg, extra))
                    seg, extra = "", set()
                    grown = {ch} if self.base.char(ch) is None else set()
                extra = grown
                seg += ch
            segments.append((seg, extra))
            for seg, extra in segments:
                if extra:
                    self.upload(self.base.augmented(sorted(extra), seg))
                elif self.keymap is not self.base:
                    self.upload(self.base)
                self.activate()
                for ch in seg:
                    self.stroke(*self.keymap.char(ch))
            if self.keymap is not self.base:
                self.conn.roundtrip()
                self.upload(self.base)
                self.activated = False
            return None
        if op == "sleep":
            self.conn.roundtrip()
            time.sleep(max(0, min(60_000, float(s[1]))) / 1000)
        elif op == "key":
            self.ensure_keyboard()
            if not self.activated:
                self.activate()
            kc, level = self.keymap.lookup(str(s[1]))
            down = bool(s[2])
            shift = self.keymap.lookup("Shift_L")[0] if level == 1 else None
            if down:
                if shift:
                    self.key(shift, True)
                self.key(kc, True)
            else:
                self.key(kc, False)
                if shift and shift in self.keys:
                    self.key(shift, False)
        elif op == "move":
            self.ensure_pointer()
            x, y, w, h = (int(round(float(v))) for v in s[1:5])
            if not (0 <= x < w and 0 <= y < h):
                raise WaylandError("bad_args", "pointer target is outside the output layout")
            self.conn.send(self.pointer, 1, struct.pack("<IIIII", self.now(), x, y, w, h))
            self.conn.send(self.pointer, 4)
        elif op == "button":
            self.ensure_pointer()
            button, down = int(s[1]), bool(s[2])
            self.conn.send(self.pointer, 2, struct.pack("<III", self.now(), button, 1 if down else 0))
            self.conn.send(self.pointer, 4)
            (self.buttons.add if down else self.buttons.discard)(button)
        elif op == "axis":
            self.ensure_pointer()
            axis, value, discrete = int(s[1]), float(s[2]), int(s[3])
            if self.pointer_version >= 2:
                self.conn.send(self.pointer, 5, struct.pack("<I", 0))  # axis_source wheel
                self.conn.send(self.pointer, 7, struct.pack("<IIii", self.now(), axis, int(value * 256), discrete))
            else:
                self.conn.send(self.pointer, 3, struct.pack("<IIi", self.now(), axis, int(value * 256)))
            self.conn.send(self.pointer, 4)
        else:
            raise WaylandError("bad_args", f"unknown step {op!r}")

    def release_all(self):
        for kc in list(self.keys)[::-1]:
            self.key(kc, False)
        for b in list(self.buttons):
            self.conn.send(self.pointer, 2, struct.pack("<III", self.now(), b, 0))
            self.conn.send(self.pointer, 4)
        self.buttons.clear()
        self.conn.roundtrip()

def reply(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def main():
    try:
        dev = Devices()
    except WaylandError as e:
        reply({"ok": False, "code": e.code, "message": str(e)})
        return 1
    reply({"ok": True, "ready": True,
           "virtual_keyboard": "zwp_virtual_keyboard_manager_v1" in dev.conn.globals,
           "virtual_pointer": "zwlr_virtual_pointer_manager_v1" in dev.conn.globals})
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            try:
                out = {"ok": True}
                dev.activated = False
                for s in json.loads(line)["steps"]:
                    out.update(dev.step(s) or {})
                dev.conn.roundtrip()
                reply(out)
            except WaylandError as e:
                try:
                    dev.release_all()
                except WaylandError:
                    pass
                reply({"ok": False, "code": e.code, "message": str(e)})
                if e.code in ("compositor_gone", "protocol_error"):
                    return 1
            except (ValueError, KeyError, IndexError, TypeError) as e:
                reply({"ok": False, "code": "bad_args", "message": str(e)})
    finally:
        try:
            dev.release_all()
        except (WaylandError, OSError):
            pass
    return 0

if __name__ == "__main__":
    sys.exit(main())
