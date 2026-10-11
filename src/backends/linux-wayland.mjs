// Linux Wayland session: screenshots (grim), clipboard (wl-clipboard), window
// and output lists (swaymsg/hyprctl) and input (wtype/ydotool). linux.mjs
// selects the session and delegates every Wayland branch here.
import { ExecError, tryJson, throwIfAborted } from "../exec.mjs";

const ownerUnknown = (message) => Object.assign(new ExecError(message), { code: "input_owner_unknown" });

export function createWayland({ run, need, tools, keyName }) {
  async function ydotool(args, opts = {}) {
    need("ydotool", "input on Wayland (ydotool needs its daemon running: sudo ydotoold)");
    throwIfAborted();
    const r = await run("ydotool", args, opts);
    throwIfAborted();
    if (r.code !== 0) throw new ExecError(`ydotool exited ${r.code}: ${r.stderr.trim().slice(0, 200)}`, r);
    return r.stdout.trim();
  }

  async function key(text, { repeat = 1, holdMs = 0 } = {}) {
    need("wtype", "key presses on Wayland");
    const parts = String(text).split("+").map((part) => part.trim().toLowerCase());
    const aliases = { control: "ctrl", meta: "logo", cmd: "logo", super: "logo" };
    const modifiers = new Set(["ctrl", "alt", "shift", "logo", "win", "altgr", "capslock"]);
    const rawKey = parts.pop();
    const k = keyName(rawKey);
    const mods = parts.map((part) => aliases[part] ?? part);
    if (!k || mods.some((mod) => !modifiers.has(mod))) throw new ExecError(`unknown key combination "${text}"`);
    const modKey = aliases[rawKey] ?? rawKey;
    const onlyModifier = modifiers.has(modKey);
    const args = mods.flatMap((mod) => ["-M", mod]);
    for (let i = 0; i < repeat; i++) {
      args.push(onlyModifier ? "-M" : "-P", onlyModifier ? modKey : k);
      if (holdMs) args.push("-s", String(holdMs));
      args.push(onlyModifier ? "-m" : "-p", onlyModifier ? modKey : k);
    }
    args.push(...mods.reverse().flatMap((mod) => ["-m", mod]));
    // wtype owns a temporary Wayland keyboard; the compositor releases its
    // keys on process exit, including cancellation. Keep the complete gesture
    // in one process (https://github.com/atx/wtype#usage).
    throwIfAborted();
    const result = await run("wtype", args, { timeoutMs: Math.max(10_000, holdMs + 8_000) });
    throwIfAborted();
    if (result.code !== 0) throw new ExecError(`wtype exited ${result.code}: ${result.stderr.trim().slice(0, 200)}`, result);
  }

  return {
    shotTool() {
      need("grim", "screenshots on Wayland");
      return { cmd: "grim", base: [] };
    },
    shotArgs(region, file) {
      const args = [];
      if (region) args.push("-g", `${Math.round(region[0])},${Math.round(region[1])} ${Math.round(region[2])}x${Math.round(region[3])}`);
      args.push(file);
      return args;
    },
    async keyboardOwner() {
      throw ownerUnknown("Linux Wayland does not expose the focused window to Codewhale, so keyboard input is refused rather than sent to an unknown window; use an X11 session");
    },
    async pointOwner() {
      throw ownerUnknown("Linux Wayland does not expose pointer ownership to Codewhale, so pointer input is refused; use an X11 session");
    },
    key,
    async type(text) {
      need("wtype", "typing on Wayland");
      const r = await run("wtype", ["--", String(text)], { timeoutMs: 15_000 });
      if (r.code !== 0) throw new ExecError(`wtype failed: ${r.stderr.slice(0, 200)}`, r);
    },
    move(x, y) {
      return ydotool(["moveto", String(x), String(y)]);
    },
    click(button, clicks) {
      // ydotool click mask: down|up|count nibble (0xC0 = left click once, +1 per extra click;
      // 0x04 bit selects right button, 0x02 middle).
      const count = Math.max(1, Math.min(3, clicks));
      const code = button === 3 ? 0xc0 + count + 0x04 : button === 2 ? 0xc0 + count + 0x02 : 0xc0 + count - 1;
      return ydotool(["click", "0x" + code.toString(16)]);
    },
    mouseDown() {
      return ydotool(["click", "0x40"]);
    },
    mouseUp(opts) {
      return ydotool(["click", "0x80"], opts);
    },
    async scroll() {
      throw new ExecError('scroll on Wayland is not available in this build; use swipe-style drags or run an X11/XWayland window. (Roadmap: ydotool wheel events.)');
    },
    /** Outputs from the compositor, or null when neither swaymsg nor hyprctl answers. */
    async displays() {
      if (tools.swaymsg) {
        const r = await run("swaymsg", ["-t", "get_outputs", "-r"], { timeoutMs: 15_000 });
        const outs = tryJson(r.stdout, []);
        if (Array.isArray(outs) && outs.length) {
          return outs.map((o, i) => ({ index: i + 1, name: o.name, points: { x: o.rect?.x, y: o.rect?.y, w: o.rect?.width, h: o.rect?.height }, pixels: { w: o.current_mode?.width, h: o.current_mode?.height }, scale: o.scale ?? 1, main: i === 0 }));
        }
      }
      if (tools.hyprctl) {
        const r = await run("hyprctl", ["-j", "monitors"], { timeoutMs: 15_000 });
        const ms = tryJson(r.stdout, []);
        if (Array.isArray(ms) && ms.length) {
          return ms.map((o, i) => ({ index: i + 1, name: o.name, points: { x: o.x, y: o.y, w: o.width, h: o.height }, pixels: { w: o.width, h: o.height }, scale: o.scale ?? 1, main: !!o.main || i === 0 }));
        }
      }
      return null;
    },
    /** Toplevel windows from the compositor, or null when neither swaymsg nor hyprctl exists. */
    async windows() {
      if (tools.swaymsg) {
        const r = await run("swaymsg", ["-t", "get_tree", "-r"], { timeoutMs: 15_000 });
        const windows = [];
        const walk = (n) => {
          if (n.type === "con" && n.name) windows.push({ id: String(n.id), title: n.name, wm_class: n.app_id ?? null, position: { x: n.rect?.x, y: n.rect?.y }, size: { w: n.rect?.width, h: n.rect?.height }, focused: !!n.focused });
          (n.nodes ?? []).forEach(walk);
          (n.floating_nodes ?? []).forEach(walk);
        };
        walk(tryJson(r.stdout, {}));
        return windows;
      }
      if (tools.hyprctl) {
        const r = await run("hyprctl", ["-j", "clients"], { timeoutMs: 15_000 });
        const clients = tryJson(r.stdout, []);
        return clients.map((c) => ({ id: String(c.address), title: c.title, wm_class: c.class, position: { x: c.at?.[0], y: c.at?.[1] }, size: { w: c.size?.[0], h: c.size?.[1] }, focused: !!c.focused }));
      }
      return null;
    },
    clipboardRead: () => ["wl-paste", "--no-newline"],
    clipboardWrite: () => ["wl-copy"],
  };
}
