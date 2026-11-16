// Minimal Chrome DevTools Protocol client (Node 22+ has a global WebSocket).
export const CDP_HTTP = process.env.NIJI_CDP || 'http://127.0.0.1:9222';

export async function listTargets() {
  const r = await fetch(`${CDP_HTTP}/json/list`);
  return r.json();
}

export async function browserWsUrl() {
  const r = await fetch(`${CDP_HTTP}/json/version`);
  return (await r.json()).webSocketDebuggerUrl;
}

export function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    ws.onerror = () => reject(new Error(`Cannot connect to Chrome at ${wsUrl}`));
    ws.onclose = () => {
      for (const p of pending.values()) p.reject(new Error('Chrome connection closed'));
      pending.clear();
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params, msg.sessionId);
      }
    };
    ws.onopen = () =>
      resolve({
        send(method, params = {}, sessionId) {
          return new Promise((res, rej) => {
            const n = ++id;
            pending.set(n, { resolve: res, reject: rej, method });
            ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
          });
        },
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          ws.close();
        },
      });
  });
}

/** Finds the nijijourney.com page target. */
export async function nijiTarget() {
  const targets = await listTargets();
  return targets.find((t) => t.type === 'page' && /^https:\/\/(www\.)?nijijourney\.com/.test(t.url)) || null;
}
