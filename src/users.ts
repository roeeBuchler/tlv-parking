// Accounts (username + password) and each user's favorite places (נקודות ציון), each with its own favorite lots. D1.
// Session = random token in an HttpOnly cookie; only its SHA-256 is stored.
// ponytail: no login rate limit in code; add a Cloudflare rate-limiting rule on /api/auth/* (PBKDF2 already slows guessing)
import { lots } from "./search.ts";

export type Env = { DB: any }; // D1Database

const enc = new TextEncoder();
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((x) => parseInt(x, 16)));
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

// 100k iterations: the Workers runtime maximum for PBKDF2
async function pbkdf2(pw: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256));
}
export async function hashPassword(pw: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${hex(salt)}:${await pbkdf2(pw, salt)}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const got = enc.encode(await pbkdf2(pw, unhex(salt))), want = enc.encode(hash);
  let diff = got.length ^ want.length; // constant time
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

const DAYS30 = 30 * 864e5;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
const cookie = (token: string, maxAge: number) => ({ "set-cookie": `sid=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}` });
const sid = (req: Request) => req.headers.get("cookie")?.match(/(?:^|;\s*)sid=([0-9a-f]{64})/)?.[1];

async function currentUser(req: Request, env: Env): Promise<{ id: number; username: string } | null> {
  const t = sid(req);
  if (!t) return null;
  return env.DB.prepare("SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?")
    .bind(await sha256(t), Date.now()).first();
}
async function startSession(env: Env, user: { id: number; username: string }) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), user.id, Date.now() + DAYS30),
  ]);
  return json({ user }, 200, cookie(token, DAYS30 / 1000));
}

// null = not a users route
export async function handleUsers(req: Request, env: Env, path: string): Promise<Response | null> {
  if (!path.startsWith("/api/auth/") && path !== "/api/me" && !path.startsWith("/api/favorites")) return null;
  const m = req.method;
  // the cookie is SameSite=Lax; also refuse cross-site writes outright
  if (m !== "GET" && req.headers.get("origin") && req.headers.get("origin") !== new URL(req.url).origin) return json({ error: "Bad origin" }, 403);
  const body = m === "POST" || m === "PATCH" ? await req.json().catch(() => ({})) as Record<string, unknown> : {};
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string).trim() : "");

  if (path === "/api/auth/register" && m === "POST") {
    const username = str("username"), password = typeof body.password === "string" ? body.password : "";
    if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) return json({ error: "username: 3–32 letters, digits, _ . -" }, 400);
    if (password.length < 8 || password.length > 200) return json({ error: "password: at least 8 characters" }, 400);
    const row = await env.DB.prepare("INSERT INTO users (username, pw) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id, username")
      .bind(username, await hashPassword(password)).first();
    return row ? startSession(env, row) : json({ error: "username taken" }, 409);
  }
  if (path === "/api/auth/login" && m === "POST") {
    const row = await env.DB.prepare("SELECT id, username, pw FROM users WHERE username = ?").bind(str("username")).first();
    if (!row || !(await verifyPassword(String(body.password ?? ""), row.pw))) return json({ error: "wrong username or password" }, 401);
    return startSession(env, { id: row.id, username: row.username });
  }
  if (path === "/api/auth/logout" && m === "POST") {
    const t = sid(req);
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, cookie("", 0));
  }

  const user = await currentUser(req, env);
  if (path === "/api/me") return json({ user });
  if (!user) return json({ error: "sign in first" }, 401);

  if (path === "/api/favorites" && m === "GET") {
    const [{ results: places }, { results: picks }] = await env.DB.batch([
      env.DB.prepare("SELECT id, label, lat, lng FROM favorites WHERE user_id = ? ORDER BY id").bind(user.id),
      env.DB.prepare("SELECT fl.favorite_id, fl.lot_id, fl.name FROM favorite_lots fl JOIN favorites f ON f.id = fl.favorite_id WHERE f.user_id = ? ORDER BY fl.rowid").bind(user.id),
    ]);
    return json({ favorites: places.map((f: any) => ({ ...f, lots: picks.filter((l: any) => l.favorite_id === f.id).map(({ lot_id, name }: any) => ({ lot_id, name })) })) });
  }
  if (path === "/api/favorites" && m === "POST") {
    const label = str("label").slice(0, 100), lat = Number(body.lat), lng = Number(body.lng);
    if (!label || !(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return json({ error: "label, lat, lng required" }, 400);
    const { n } = await env.DB.prepare("SELECT count(*) n FROM favorites WHERE user_id = ?").bind(user.id).first();
    if (n >= 100) return json({ error: "too many favorites" }, 400);
    const row = await env.DB.prepare("INSERT INTO favorites (user_id, label, lat, lng) VALUES (?, ?, ?, ?) RETURNING id, label, lat, lng").bind(user.id, label, lat, lng).first();
    return json({ favorite: { ...row, lots: [] } }, 201);
  }

  // /api/favorites/:id and /api/favorites/:id/lots[/:lot_id]; every query is scoped to the user's own rows
  const r = path.match(/^\/api\/favorites\/(\d+)(\/lots(?:\/([^/]+))?)?$/);
  if (!r) return json({ error: "Not found" }, 404);
  const id = +r[1], mine = "(SELECT id FROM favorites WHERE id = ? AND user_id = ?)";
  if (!r[2] && m === "PATCH") {
    const label = str("label").slice(0, 100);
    if (!label) return json({ error: "label required" }, 400);
    await env.DB.prepare("UPDATE favorites SET label = ? WHERE id = ? AND user_id = ?").bind(label, id, user.id).run();
    return json({ ok: true });
  }
  if (!r[2] && m === "DELETE") {
    await env.DB.prepare("DELETE FROM favorites WHERE id = ? AND user_id = ?").bind(id, user.id).run();
    return json({ ok: true });
  }
  if (r[2] && !r[3] && m === "POST") {
    const lot = lots.find((l) => l.id === str("lot_id")); // name from our data, not the client
    if (!lot) return json({ error: "No such lot" }, 400);
    await env.DB.prepare(`INSERT OR IGNORE INTO favorite_lots (favorite_id, lot_id, name) SELECT id, ?, ? FROM ${mine}`).bind(lot.id, lot.name, id, user.id).run();
    return json({ ok: true });
  }
  if (r[3] && m === "DELETE") {
    await env.DB.prepare(`DELETE FROM favorite_lots WHERE lot_id = ? AND favorite_id IN ${mine}`).bind(decodeURIComponent(r[3]), id, user.id).run();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
