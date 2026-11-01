import { defaultConnect, makeChannel } from "../browser-cdp.mjs";
import { ExecError, currentSignal, throwIfAborted, wait } from "../exec.mjs";
import crypto from "node:crypto";

const refused = (message) => Object.assign(new ExecError(`chromium_pointer_unavailable: ${message}. No pointer input was sent; use an accessible control or a browser connection.`), { code: "chromium_pointer_unavailable" });
const probe = "JSON.stringify({x:screenX,y:screenY,w:outerWidth,h:outerHeight,iw:innerWidth,ih:innerHeight,title:document.title,url:location.href,hidden:document.hidden})";
const closeOptions = { signal: null, timeoutMs: 1000 };
const worlds = new WeakMap();

async function endpoints(pid, run) {
  const process = await run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], { timeoutMs: 3000 });
  const flag = process.code === 0 && process.stdout.match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)(?:\s|$)/);
  if (!flag) throw refused("this app was not started with a renderer debugging port; Computer Use does not enable debugging or open a Node inspector");
  const ports = await run("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { timeoutMs: 3000 });
  if (ports.aborted) throwIfAborted();
  const result = new Set();
  for (const line of (ports.stdout ?? "").split("\n")) {
    const match = line.match(/^n(127\.0\.0\.1|\[::1\]):(\d+)$/);
    if (match && (+flag[1] === 0 || +flag[1] === +match[2])) result.add(`http://${match[1]}:${match[2]}`);
  }
  if (!result.size) throw refused("the bound process has no matching loopback renderer listener");
  if (result.size > 8) throw refused("too many renderer listener candidates");
  return [...result];
}

async function pages(endpoint) {
  const signal = currentSignal();
  const response = await fetch(`${endpoint}/json/list`, { redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000) });
  if (!response.ok) return [];
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) throw refused("the renderer target list exceeds the reply limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const list = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return Array.isArray(list) ? list.filter(p => p.type === "page").slice(0, 32) : [];
}

async function geometry(channel, live = false) {
  let world = worlds.get(channel);
  if (!live) {
    const { frameTree } = await channel.send("Page.getFrameTree", {}, undefined, { timeoutMs: 2000 });
    const frame = frameTree?.frame;
    if (!frame?.id || !frame.loaderId) return null;
    if (!world || world.loader !== frame.loaderId) {
      const { executionContextId } = await channel.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: `CodewhaleInput-${crypto.randomUUID()}`, grantUniveralAccess: false }, undefined, { timeoutMs: 2000 });
      world = { contextId: executionContextId, loader: frame.loaderId, frameId: frame.id };
      worlds.set(channel, world);
    }
  }
  if (!world) return null;
  const reply = await channel.send("Runtime.evaluate", { expression: probe, contextId: world.contextId, returnByValue: true, silent: true }, undefined, { timeoutMs: 2000 });
  if (reply.exceptionDetails || typeof reply.result?.value !== "string") return null;
  return { ...JSON.parse(reply.result.value), loader: world.loader, frameId: world.frameId };
}

function matches(context, value) {
  const w = context.window, web = context.web;
  return value && web && !value.hidden && value.iw > 0 && value.ih > 0 &&
    ["x", "y", "w", "h"].every(k => Number.isFinite(value[k]) && Math.abs(value[k] - w[k]) <= 2) &&
    (web.title || web.url) && (!web.title || web.title === value.title) && (!web.url || web.url === value.url);
}

export async function chromiumPointer(context, steps, { run, validate }) {
  if (!context.web) throw refused("this point is outside an accessible web surface in the bound window");
  const connections = [];
  let chosen, removeListener, held = false, intercepted = false, dropped = false, completed = false, inputSent = false, last;
  const navigationListeners = [];
  try {
    for (const endpoint of await endpoints(context.pid, run)) {
      let targets;
      try { targets = await pages(endpoint); } catch (error) { throwIfAborted(); continue; }
      for (const target of targets) {
        throwIfAborted();
        let url;
        try { url = new URL(target.webSocketDebuggerUrl); } catch { continue; }
        const origin = new URL(endpoint);
        if (url.protocol !== "ws:" || url.hostname !== origin.hostname || url.port !== origin.port || !/^\/devtools\/page\//.test(url.pathname) || url.username || url.password) continue;
        let channel;
        try {
          channel = makeChannel(await defaultConnect(url.href, { timeoutMs: 2000 }));
          connections.push(channel);
          const value = await geometry(channel);
          if (matches(context, value)) {
            if (chosen) throw refused("more than one visible renderer matches the exact window");
            chosen = { channel, value };
          }
        } catch (error) {
          if (error.code === "chromium_pointer_unavailable") throw error;
          throwIfAborted();
          channel?.close();
        }
      }
    }
    if (!chosen) throw refused("no visible renderer matches the bound window geometry, title and URL");
    const { channel, value } = chosen;
    let invalidated = false;
    navigationListeners.push(
      channel.on("Page.frameNavigated", ({ params }) => { if (params?.frame?.id === value.frameId && params.frame.loaderId !== value.loader) invalidated = true; }),
      channel.on("Page.frameDetached", ({ params }) => { if (params?.frameId === value.frameId) invalidated = true; }),
      channel.on("Page.frameResized", () => { invalidated = true; }),
      channel.on("Page.javascriptDialogOpening", () => { invalidated = true; }),
      channel.on("Runtime.executionContextsCleared", () => { invalidated = true; }),
      channel.on("Runtime.executionContextDestroyed", ({ params }) => { if (params?.executionContextId === worlds.get(channel)?.contextId) invalidated = true; }),
    );
    await Promise.all([channel.send("Page.enable"), channel.send("Runtime.enable")]);
    const scale = context.web.w / value.iw;
    if (!Number.isFinite(scale) || scale < .1 || scale > 8) throw refused("the renderer scale could not be confirmed");
    const points = steps.map(step => ({ x: (step.x - context.web.x) / scale, y: (step.y - context.web.y) / scale }));
    if (points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x >= value.iw || p.y >= value.ih)) throw refused("the gesture leaves this renderer viewport");
    const fresh = await geometry(channel);
    if (invalidated || !matches(context, fresh) || fresh.iw !== value.iw || fresh.ih !== value.ih || fresh.loader !== value.loader) throw refused("the renderer changed before input");
    const drag = steps.some(s => [6, 7, 27].includes(s.type));
    let dragData = null;
    if (drag) removeListener = channel.on("Input.dragIntercepted", message => { dragData = message.params.data; });
    if (drag) await channel.send("Input.setInterceptDrags", { enabled: true });
    for (let i = 0; i < steps.length; i++) {
      throwIfAborted();
      await validate();
      const current = invalidated ? null : await geometry(channel, true);
      if (invalidated || !matches(context, current) || current.iw !== value.iw || current.ih !== value.ih) throw new ExecError("The renderer navigated, resized, became hidden, opened a dialog or lost its isolated context; observe before retrying");
      const step = steps[i], point = points[i];
      const down = [1, 3, 25].includes(step.type), up = [2, 4, 26].includes(step.type);
      const button = step.button === 1 ? "right" : step.button === 2 ? "middle" : "left";
      const mask = step.button === 1 ? 2 : step.button === 2 ? 4 : 1;
      if (down) held = true;
      last = { ...point, button };
      inputSent = true;
      if (dragData && !down) {
        if (!intercepted) {
          await channel.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data: dragData });
          intercepted = true;
        }
        await channel.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data: dragData });
        if (up) {
          await channel.send("Input.dispatchDragEvent", { type: "drop", ...point, data: dragData });
          dropped = true;
        }
      }
      await channel.send("Input.dispatchMouseEvent", { type: down ? "mousePressed" : up ? "mouseReleased" : "mouseMoved", ...point,
        button: down || up || held ? button : "none", buttons: up ? 0 : held ? mask : 0, clickCount: down || up ? 1 : 0, pointerType: "mouse" });
      if (up) held = false;
      await wait(Math.max(1, Math.min(250, step.delayMs ?? 20)));
    }
    completed = true;
    return { action_sent: true, strategy: "chromium-cdp", input_scope: "application-window", pointer_moved: false, front_lease: false,
      window: { id: context.window.id }, drag_intercepted: intercepted, html5_drop: dropped, verified: false, verification_required: "observation" };
  } catch (error) {
    if (inputSent) {
      error.inputMayHaveBeenSent = true;
      error.message += "; input may have been sent — observe before retrying";
    }
    throw error;
  } finally {
    if (chosen) {
      const { channel } = chosen;
      if (held && last) await channel.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...last, buttons: 0, clickCount: 1 }, undefined, closeOptions).catch(() => {});
      if (!completed) await channel.send("Input.cancelDragging", {}, undefined, closeOptions).catch(() => {});
      await channel.send("Input.setInterceptDrags", { enabled: false }, undefined, closeOptions).catch(() => {});
    }
    removeListener?.();
    for (const remove of navigationListeners) remove();
    for (const connection of connections) connection.close();
  }
}
