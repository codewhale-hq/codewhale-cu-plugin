// The pid of the X client that owns a window, from the X server itself
// (X-Resource 1.2 XResQueryClientIds). Toolkits such as Tk set no
// _NET_WM_PID, so without this a window has no process identity at all.
// Local displays only (unix socket, MIT-MAGIC-COOKIE-1 or no auth); any
// failure returns null and the caller keeps the window's other identity.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const pad4 = (n) => (4 - (n % 4)) % 4;

function displayNumber(display) {
  const m = /^(?:unix)?:(\d+)(?:\.\d+)?$/.exec(String(display ?? ""));
  return m ? m[1] : null;
}

/** The MIT-MAGIC-COOKIE-1 for a local display from the Xauthority file, or null. */
function cookie(number) {
  const file = process.env.XAUTHORITY || path.join(os.homedir(), ".Xauthority");
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  const host = os.hostname();
  let off = 0;
  const field = () => {
    const len = buf.readUInt16BE(off);
    const value = buf.subarray(off + 2, off + 2 + len);
    off += 2 + len;
    return value;
  };
  try {
    while (off < buf.length) {
      const family = buf.readUInt16BE(off); off += 2;
      const addr = field().toString("latin1");
      const num = field().toString("latin1");
      const name = field().toString("latin1");
      const data = field();
      const local = family === 256 ? addr === host : family === 65535;
      if (local && (num === "" || num === number) && name === "MIT-MAGIC-COOKIE-1") return data;
    }
  } catch { /* truncated file: no cookie */ }
  return null;
}

function connect(number, timeoutMs) {
  const tryPath = (p) => new Promise((resolve) => {
    const sock = net.createConnection(p);
    const done = (value) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { sock.destroy(); done(null); }, timeoutMs);
    sock.once("connect", () => done(sock));
    sock.once("error", () => done(null));
  });
  return tryPath(`/tmp/.X11-unix/X${number}`).then((s) => s ?? tryPath(`\0/tmp/.X11-unix/X${number}`));
}

function setupRequest(auth) {
  const name = auth ? Buffer.from("MIT-MAGIC-COOKIE-1") : Buffer.alloc(0);
  const data = auth ?? Buffer.alloc(0);
  const head = Buffer.alloc(12);
  head.writeUInt8(0x6c, 0); // little-endian
  head.writeUInt16LE(11, 2);
  head.writeUInt16LE(0, 4);
  head.writeUInt16LE(name.length, 6);
  head.writeUInt16LE(data.length, 8);
  return Buffer.concat([head, name, Buffer.alloc(pad4(name.length)), data, Buffer.alloc(pad4(data.length))]);
}

function queryExtension(name) {
  const n = Buffer.from(name);
  const req = Buffer.alloc(8);
  req.writeUInt8(98, 0);
  req.writeUInt16LE(2 + (n.length + pad4(n.length)) / 4, 2);
  req.writeUInt16LE(n.length, 4);
  return Buffer.concat([req, n, Buffer.alloc(pad4(n.length))]);
}

function queryClientPid(major, windowId) {
  const req = Buffer.alloc(16);
  req.writeUInt8(major, 0);
  req.writeUInt8(4, 1); // XResQueryClientIds
  req.writeUInt16LE(4, 2);
  req.writeUInt32LE(1, 4); // one spec
  req.writeUInt32LE(windowId, 8); // any resource id names its client
  req.writeUInt32LE(2, 12); // XRES_CLIENT_ID_PID_MASK
  return req;
}

/** Pid of the client owning `windowId` on local `display`, or null. */
export async function windowClientPid(windowId, { display = process.env.DISPLAY, timeoutMs = 2_000 } = {}) {
  const number = displayNumber(display);
  const id = Number(windowId);
  if (number === null || !Number.isInteger(id) || id <= 0 || id > 0xffffffff) return null;
  const sock = await connect(number, timeoutMs);
  if (!sock) return null;
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let stage = "setup";
    const finish = (value) => { clearTimeout(timer); sock.destroy(); resolve(value); };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (stage === "setup") {
          if (buf.length < 8) return;
          const total = 8 + buf.readUInt16LE(6) * 4;
          if (buf.length < total) return;
          if (buf[0] !== 1) return finish(null);
          buf = buf.subarray(total);
          stage = "extension";
          sock.write(queryExtension("X-Resource"));
          continue;
        }
        if (buf.length < 32) return;
        if (buf[0] !== 1) return finish(null); // an X error: no XRes 1.2, or the window is gone
        const total = 32 + buf.readUInt32LE(4) * 4;
        if (buf.length < total) return;
        const reply = buf.subarray(0, total);
        buf = buf.subarray(total);
        if (stage === "extension") {
          if (!reply[8]) return finish(null);
          stage = "pid";
          sock.write(queryClientPid(reply[9], id));
          continue;
        }
        let off = 32;
        for (let i = 0; i < reply.readUInt32LE(8) && off + 12 <= reply.length; i++) {
          const mask = reply.readUInt32LE(off + 4);
          const len = reply.readUInt32LE(off + 8);
          if (mask & 2 && len >= 4 && off + 16 <= reply.length) {
            const pid = reply.readUInt32LE(off + 12);
            // An id no client owns falls in this connection's own range.
            return finish(pid > 0 && pid !== process.pid ? pid : null);
          }
          off += 12 + len;
        }
        return finish(null);
      }
    });
    sock.write(setupRequest(cookie(number)));
  });
}
