import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HandoffBoundary, HandoffBoundaryError, assertHandoffOrigin } from "./handoffBoundary";
import type { BrowserHandoffControl } from "../../src/domain/executor";

export interface HandoffBridge {
  screenshot(): Promise<Buffer>;
  controls(): Promise<readonly BrowserHandoffControl[]>;
  activate(controlId: string, point?: { x: number; y: number }): Promise<void>;
}

export interface HandoffViewerServerOptions {
  boundary: HandoffBoundary;
  bridgeForExecution: (executionId: string) => HandoffBridge | undefined;
  host?: string;
  port?: number;
  origin?: string;
}

export interface HandoffViewerServer {
  server: Server;
  host: string;
  port: number;
  listen(): Promise<number>;
  setPublicOrigin(origin: string): void;
  getPublicOrigin(): string;
  close(): Promise<void>;
}

function headers(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Content-Security-Policy", "default-src 'none'; connect-src 'self'; img-src 'self' data: blob:; script-src 'unsafe-inline'; style-src 'unsafe-inline'");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  headers(response);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function tokenFromCookie(request: IncomingMessage): string | undefined {
  const cookie = request.headers.cookie ?? "";
  const match = cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("atelier_handoff_session="));
  return match?.slice("atelier_handoff_session=".length);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 16 * 1024) {
      request.destroy();
      throw new HandoffBoundaryError("The handoff request is too large.", "invalid");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new HandoffBoundaryError("The handoff request is invalid.", "invalid"); }
}

function errorStatus(error: unknown): number {
  if (error instanceof HandoffBoundaryError) return error.code === "forbidden" ? 403 : error.code === "expired" ? 410 : 400;
  return 500;
}

/** Isolated viewer: it has no execution-host routes and only semantic controls. */
export function createHandoffViewerServer(options: HandoffViewerServerOptions): HandoffViewerServer {
  const host = options.host ?? "127.0.0.1";
  if (!(host === "127.0.0.1" || host === "localhost" || host === "::1")) throw new Error("The handoff viewer must bind to loopback.");
  const port = options.port ?? 0;
  let origin = options.origin ?? `http://${host}:${port}`;
  const validateOrigin = (value: string): URL => {
    const parsed = new URL(value);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) throw new Error("Handoff origins must be exact origins without a path, query, or fragment.");
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]"))) throw new Error("A non-loopback handoff origin must use HTTPS.");
    return parsed;
  };
  origin = validateOrigin(origin).origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (url.pathname === "/handoff" && request.method === "GET") {
        headers(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opening browser handoff</title><p id="status">Opening secure handoff…</p><script>(async()=>{const token=location.hash.startsWith('#token=')?decodeURIComponent(location.hash.slice(7)):'';if(!token)throw new Error('Handoff token missing');const r=await fetch('/handoff/redeem',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw new Error('Handoff expired or already used');const result=await r.json();location.replace(result.location)})().catch(e=>document.querySelector('#status').textContent=e.message)</script>`);
        return;
      }
      if (url.pathname === "/handoff/redeem" && request.method === "POST") {
        assertHandoffOrigin(typeof request.headers.origin === "string" ? request.headers.origin : undefined, [origin]);
        const value = await body(request);
        const grant = value && typeof value === "object" && !Array.isArray(value) ? (value as { token?: unknown }).token : undefined;
        if (typeof grant !== "string" || !grant) throw new HandoffBoundaryError("The handoff token is invalid.", "invalid");
        const session = options.boundary.redeem(grant);
        headers(response); response.statusCode = 200; response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Set-Cookie", `atelier_handoff_session=${session.token}; HttpOnly; SameSite=Strict; Path=/handoff; Max-Age=600${new URL(origin).protocol === "https:" ? "; Secure" : ""}`);
        response.end(JSON.stringify({ location: `/handoff/view/${encodeURIComponent(session.executionId)}` }));
        return;
      }
      if (url.pathname.startsWith("/handoff/view/") && request.method === "GET") {
        headers(response);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser verification</title><style>body{font:16px sans-serif;max-width:900px;margin:2rem auto}img{max-width:100%;border:1px solid #ccc;touch-action:manipulation}button{padding:.7rem 1rem}</style><img id="screen" alt="Live browser"><p id="status">Loading…</p><button id="verify" hidden>Verify you are human</button><script>const id=location.pathname.split('/').pop();let control;let timer;let imageUrl;const screen=document.querySelector('#screen');const verify=document.querySelector('#verify');const status=document.querySelector('#status');const api=async(path,opts)=>{const r=await fetch('/handoff/api/'+id+'/'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json',...(opts?.headers||{})},...opts});if(!r.ok)throw new Error('handoff request failed');return r};async function refresh(){const image=await api('screenshot');if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=URL.createObjectURL(await image.blob());screen.src=imageUrl;const data=await (await api('controls')).json();control=data.controls.length===1?data.controls[0]:undefined;verify.hidden=!control||control.id==='captcha-frame';verify.textContent='Verify you are human';screen.style.cursor=control?.id==='captcha-frame'?'crosshair':'default';status.textContent=control?(control.id==='captcha-frame'?'Tap a CAPTCHA tile in the image.':'Click Verify you are human to continue.'):'Waiting for browser state; checking again…';if(timer)clearTimeout(timer);if(!control)timer=setTimeout(()=>refresh().catch(e=>status.textContent=e.message),1000)}screen.onclick=async(event)=>{if(control?.id!=='captcha-frame')return;const rect=screen.getBoundingClientRect();const x=(event.clientX-rect.left)*(screen.naturalWidth/rect.width);const y=(event.clientY-rect.top)*(screen.naturalHeight/rect.height);await api('control',{method:'POST',body:JSON.stringify({controlId:'captcha-frame',x,y})});await refresh()};verify.onclick=async()=>{if(control?.id!=='verify-human')return;verify.disabled=true;try{await api('control',{method:'POST',body:JSON.stringify({controlId:'verify-human'})});await refresh()}finally{verify.disabled=false}};refresh().catch(e=>status.textContent=e.message);</script>`);
        return;
      }
      const match = url.pathname.match(/^\/handoff\/api\/([^/]+)\/(screenshot|controls|control)$/);
      if (!match) return json(response, 404, { error: "Route not found." });
      // Browsers normally omit Origin on same-origin GETs. SameSite=Strict
      // protects these read-only requests; state-changing control POSTs still
      // require an exact Origin header below.
      if (request.method !== "GET") {
        assertHandoffOrigin(typeof request.headers.origin === "string" ? request.headers.origin : undefined, [origin]);
      }
      const executionId = decodeURIComponent(match[1]!);
      const token = tokenFromCookie(request);
      if (!token) throw new HandoffBoundaryError("The handoff session is missing.", "forbidden");
      options.boundary.authenticate(token, executionId, "view");
      const bridge = options.bridgeForExecution(executionId);
      if (!bridge) throw new HandoffBoundaryError("The browser session is no longer available.", "expired");
      if (match[2] === "screenshot" && request.method === "GET") {
        headers(response); response.statusCode = 200; response.setHeader("Content-Type", "image/png"); response.end(await bridge.screenshot()); return;
      }
      if (match[2] === "controls" && request.method === "GET") { return json(response, 200, { controls: await bridge.controls() }); }
      if (match[2] === "control" && request.method === "POST") {
        const value = await body(request);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new HandoffBoundaryError("Only a discovered human-verification control may be activated.", "forbidden");
        const candidate = value as { controlId?: unknown; x?: unknown; y?: unknown };
        if (candidate.controlId !== "captcha-frame" && candidate.controlId !== "verify-human") throw new HandoffBoundaryError("Only a discovered human-verification control may be activated.", "forbidden");
        if (candidate.controlId === "verify-human") {
          await bridge.activate(candidate.controlId);
          return json(response, 204, {});
        }
        const point = { x: candidate.x, y: candidate.y };
        if (typeof point.x !== "number" || typeof point.y !== "number" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new HandoffBoundaryError("A CAPTCHA frame tap requires finite coordinates.", "invalid");
        await bridge.activate(candidate.controlId, { x: point.x as number, y: point.y as number });
        return json(response, 204, {});
      }
      return json(response, 405, { error: "Method not allowed." });
    } catch (error) {
      json(response, errorStatus(error), { error: error instanceof Error ? error.message : "Handoff failed." });
    }
  });
  return {
    server,
    host,
    port,
    listen: async () => {
      if (server.listening) {
        const address = server.address();
        return typeof address === "object" && address ? address.port : port;
      }
      await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, host, resolve));
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    setPublicOrigin: (value: string) => { origin = validateOrigin(value).origin; },
    getPublicOrigin: () => origin,
    close: async () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
