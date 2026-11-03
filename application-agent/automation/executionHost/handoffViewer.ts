import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HandoffBoundary, HandoffBoundaryError, assertHandoffOrigin } from "./handoffBoundary";
import { parseHandoffInput, type BrowserHandoffControl, type BrowserHandoffInput } from "../../src/domain/executor";

export interface HandoffBridge {
  screenshot(): Promise<Buffer>;
  controls(): Promise<readonly BrowserHandoffControl[]>;
  activate(controlId: string, point?: { x: number; y: number }): Promise<void>;
  /** General tap/type/key/scroll input; absent for sessions that cannot take it. */
  input?(input: BrowserHandoffInput): Promise<void>;
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

/**
 * Phone-first remote view of the waiting browser window: tap the picture to
 * click there, type into the focused field, press keys, and scroll.
 */
const VIEW_PAGE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser handoff</title>
<style>
:root{--bg:#f6f6f4;--panel:#fff;--text:#1c1c1a;--muted:#6b6b66;--line:#dddcd6;--accent:#2f5d8a;--on-accent:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#151514;--panel:#1f1f1d;--text:#ecebe6;--muted:#a3a29b;--line:#3a3935;--accent:#8fb3dc;--on-accent:#10161d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.4 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:12px}
#wrap{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:#000;touch-action:manipulation}
#screen{display:block;width:100%;cursor:pointer;user-select:none;-webkit-user-select:none}
#dot{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #e33;pointer-events:none;display:none}
#status{color:var(--muted);font-size:14px;margin:8px 0}
.row{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
button{flex:1 1 auto;min-width:56px;padding:12px 10px;font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}
button:active{background:var(--line)}
input{flex:1 1 180px;padding:12px;font:inherit;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}
#send{flex:0 0 auto;background:var(--accent);color:var(--on-accent);border-color:var(--accent)}
#wrap.zoomed{overflow:auto;max-height:70vh}#wrap.zoomed #screen{width:250%;max-width:none}
</style>
<main>
<p id="status">Loading…</p>
<div id="wrap"><img id="screen" alt="Live browser page"><div id="dot"></div></div>
<div class="row"><button data-scroll="-500">▲ Scroll up</button><button data-scroll="500">▼ Scroll down</button><button id="zoom">Zoom in</button></div>
<div class="row"><input id="text" placeholder="Tap a field above, then type here" autocomplete="off" autocapitalize="off"><button id="send">Type</button></div>
<div class="row"><button data-key="Enter">Enter</button><button data-key="Tab">Tab</button><button data-key="Backspace">⌫</button><button data-key="Space">Space</button><button data-key="Escape">Esc</button></div>
<p id="hint" style="color:var(--muted);font-size:13px">Tap the picture to click that spot (CAPTCHA boxes, tiles, buttons). Use Zoom in for small CAPTCHA tiles. When the page says your application was submitted, reply DONE in Slack.</p>
</main>
<script>
const id=location.pathname.split('/').pop();
const screen=document.querySelector('#screen'),dot=document.querySelector('#dot'),status=document.querySelector('#status'),text=document.querySelector('#text');
let imageUrl,timer,busy=false;
const api=(path,opts)=>fetch('/handoff/api/'+id+'/'+path,{credentials:'same-origin',headers:{'Content-Type':'application/json'},...opts});
async function refresh(){
  clearTimeout(timer);
  try{
    const r=await api('screenshot');
    if(r.status===410||r.status===403){status.textContent='This handoff has ended (the window closed or the link expired).';return}
    if(!r.ok)throw new Error('screenshot failed');
    const url=URL.createObjectURL(await r.blob());screen.src=url;if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=url;
    status.textContent='Live view · updates every second';
  }catch(e){status.textContent='Reconnecting…'}
  timer=setTimeout(refresh,1000);
}
async function send(input){
  if(busy)return;busy=true;
  try{const r=await api('input',{method:'POST',body:JSON.stringify(input)});if(!r.ok)status.textContent=(await r.json().catch(()=>({}))).error||'That action was not accepted.'}
  catch(e){status.textContent='Could not reach the browser.'}
  finally{busy=false;setTimeout(refresh,250)}
}
screen.addEventListener('click',(event)=>{
  const rect=screen.getBoundingClientRect();
  const x=(event.clientX-rect.left)*(screen.naturalWidth/rect.width),y=(event.clientY-rect.top)*(screen.naturalHeight/rect.height);
  dot.style.left=(event.clientX-rect.left)+'px';dot.style.top=(event.clientY-rect.top)+'px';dot.style.display='block';setTimeout(()=>dot.style.display='none',600);
  send({type:'tap',x,y});
});
document.querySelector('#send').addEventListener('click',()=>{if(text.value){send({type:'type',text:text.value});text.value=''}});
text.addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();document.querySelector('#send').click()}});
document.querySelectorAll('[data-key]').forEach((b)=>b.addEventListener('click',()=>send({type:'key',key:b.dataset.key})));
document.querySelector('#zoom').addEventListener('click',(event)=>{const wrap=document.querySelector('#wrap');wrap.classList.toggle('zoomed');event.target.textContent=wrap.classList.contains('zoomed')?'Zoom out':'Zoom in'});
document.querySelectorAll('[data-scroll]').forEach((b)=>b.addEventListener('click',()=>send({type:'scroll',dy:Number(b.dataset.scroll)})));
refresh();
</script>`;

/** Isolated viewer: it has no execution-host routes plus remote input for the waiting window. */
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
        response.end(VIEW_PAGE);
        return;
      }
      const match = url.pathname.match(/^\/handoff\/api\/([^/]+)\/(screenshot|controls|control|input)$/);
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
      if (match[2] === "input" && request.method === "POST") {
        const input = parseHandoffInput(await body(request));
        if (!input) throw new HandoffBoundaryError("Only a tap, short text, an allowed key, or a scroll can be sent.", "invalid");
        if (!bridge.input) return json(response, 409, { error: "This browser session does not accept remote input." });
        await bridge.input(input);
        return json(response, 204, {});
      }
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
