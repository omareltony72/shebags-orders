import { createClient } from "npm:@supabase/supabase-js@2";

const LV = "https://api.loyverse.com/v1.0";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SB_URL, SERVICE, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
class HttpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }

function token() {
  const t = Deno.env.get("LOYVERSE_TOKEN");
  if (!t) throw new HttpErr(400, "رمز Loyverse لسه متحطش في إعدادات Supabase (LOYVERSE_TOKEN)");
  return t;
}
async function lv(path: string, init: RequestInit = {}) {
  const r = await fetch(LV + path, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new HttpErr(502, `Loyverse ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function lvAll(path: string, key: string) {
  const out: any[] = [];
  let cursor = "";
  for (let i = 0; i < 50; i++) {
    const sep = path.includes("?") ? "&" : "?";
    const d = await lv(`${path}${sep}limit=250${cursor ? `&cursor=${cursor}` : ""}`);
    out.push(...(d[key] || []));
    if (!d.cursor) break;
    cursor = d.cursor;
  }
  return out;
}
let storeCache = "";
async function storeId() {
  const env = Deno.env.get("LOYVERSE_STORE_ID");
  if (env) return env;
  if (storeCache) return storeCache;
  const d = await lv("/stores");
  storeCache = d.stores?.[0]?.id;
  if (!storeCache) throw new HttpErr(502, "مفيش فرع في Loyverse");
  return storeCache;
}

let catCache: { at: number; data: any } | null = null;
async function catalog(force = false) {
  if (!force && catCache && Date.now() - catCache.at < 45_000) return catCache.data;
  const sid = await storeId();
  const [items, inv] = await Promise.all([lvAll("/items", "items"), lvAll("/inventory", "inventory_levels")]);
  const stock = new Map<string, number>();
  for (const l of inv) if (l.store_id === sid) stock.set(l.variant_id, Number(l.in_stock) || 0);
  const pend: any[] = []; // stock is deducted in Loyverse as soon as an order is saved
  const reserved = new Map<string, number>();
  for (const o of pend || []) for (const it of o.items) reserved.set(it.variant_id, (reserved.get(it.variant_id) || 0) + Number(it.qty));
  const products = items
    .filter((i: any) => !i.deleted_at)
    .map((i: any) => ({
      item_id: i.id,
      name: i.item_name,
      image: i.image_url || null,
      color_label: i.option1_name || null,
      track: i.track_stock !== false,
      variants: (i.variants || [])
        .filter((v: any) => !v.deleted_at)
        .map((v: any) => {
          const st = (v.stores || []).find((s: any) => s.store_id === sid);
          const s = stock.get(v.variant_id) ?? 0;
          const r = reserved.get(v.variant_id) || 0;
          return {
            variant_id: v.variant_id,
            sku: v.sku || "",
            color: [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
            price: Number(st?.price ?? v.default_price ?? 0),
            stock: s, reserved: r, available: s - r,
          };
        }),
    }));
  const data = { products, store_id: sid, at: new Date().toISOString() };
  catCache = { at: Date.now(), data };
  return data;
}

async function adjustStock(items: any[], sign: 1 | -1) {
  const sid = await storeId();
  const qty = new Map<string, number>();
  for (const it of items) qty.set(it.variant_id, (qty.get(it.variant_id) || 0) + Number(it.qty));
  const ids = [...qty.keys()];
  const inv = await lvAll(`/inventory?store_ids=${sid}&variant_ids=${ids.join(",")}`, "inventory_levels");
  const cur = new Map<string, number>();
  for (const l of inv) if (l.store_id === sid) cur.set(l.variant_id, Number(l.in_stock) || 0);
  const levels = ids.map((v) => ({ variant_id: v, store_id: sid, stock_after: (cur.get(v) ?? 0) + sign * qty.get(v)! }));
  await lv("/inventory", { method: "POST", body: JSON.stringify({ inventory_levels: levels }) });
  catCache = null;
}

const norm = (s: string) => String(s || "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, "").toLowerCase();
let payCache = "";
async function paymentTypeId() {
  const env = Deno.env.get("LOYVERSE_PAYMENT_TYPE_ID");
  if (env) return env;
  if (payCache) return payCache;
  const d = await lv("/payment_types");
  const list = d.payment_types || [];
  const hit = list.find((p: any) => norm(p.name).includes("اونلاين")) || list.find((p: any) => norm(p.name).includes("online"));
  if (!hit) throw new HttpErr(400, "مش لاقي طريقة دفع اسمها 'اوردرات اونلاين' في Loyverse. الموجود: " + list.map((p: any) => p.name).join("، "));
  payCache = hit.id;
  return payCache;
}
async function ensureCustomer(o: any) {
  if (o.loyverse_customer_id) return o.loyverse_customer_id;
  const phones = [o.phone, "+2" + o.phone, "2" + o.phone, o.phone.slice(1)];
  let found = "";
  let cursor = "";
  for (let i = 0; i < 40 && !found; i++) {
    const d = await lv(`/customers?limit=250${cursor ? `&cursor=${cursor}` : ""}`);
    for (const c of d.customers || []) {
      const ph = String(c.phone_number || "").replace(/\D/g, "");
      if (ph && phones.some((p) => ph.endsWith(p.replace(/\D/g, "").slice(-10)))) { found = c.id; break; }
    }
    if (!d.cursor) break;
    cursor = d.cursor;
  }
  if (!found) {
    const c = await lv("/customers", { method: "POST", body: JSON.stringify({
      name: o.customer_name, phone_number: o.phone, address: o.address, city: o.zone,
      note: "عميل أونلاين" + (o.phone2 ? ` - موبايل تاني ${o.phone2}` : ""),
    }) });
    found = c.id;
  }
  await admin.from("orders").update({ loyverse_customer_id: found }).eq("id", o.id);
  return found;
}
async function createReceipt(o: any, lines: any[]) {
  if (!lines.length) return null;
  const sid = await storeId();
  const pt = await paymentTypeId();
  let cid: string | undefined;
  try { cid = await ensureCustomer(o); } catch (_) { cid = undefined; }
  const total = lines.reduce((s, l) => s + Number(l.price) * Number(l.qty), 0);
  const r = await lv("/receipts", { method: "POST", body: JSON.stringify({
    store_id: sid, ...(cid ? { customer_id: cid } : {}),
    note: `أوردر أونلاين #${o.id}`,
    line_items: lines.map((l) => ({ variant_id: l.variant_id, quantity: Number(l.qty), price: Number(l.price) })),
    payments: [{ payment_type_id: pt, money_amount: total }],
  }) });
  catCache = null;
  return r.receipt_number || r.id || "ok";
}

async function me(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user) throw new HttpErr(401, "لازم تسجل دخول");
  const { data: p } = await admin.from("profiles").select("*").eq("id", data.user.id).single();
  if (!p || p.role === "disabled") throw new HttpErr(403, "الحساب ده مش متفعل");
  return p;
}
const need = (p: any, roles: string[]) => { if (!roles.includes(p.role)) throw new HttpErr(403, "مش مسموحلك بالعملية دي"); };
const now = () => new Date().toISOString();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const a = body.action;

    if (a === "needs_bootstrap") {
      const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("role", "admin");
      return json({ needs: !count });
    }
    if (a === "bootstrap") {
      const { count } = await admin.from("profiles").select("*", { count: "exact", head: true }).eq("role", "admin");
      if (count) throw new HttpErr(403, "فيه أدمن بالفعل");
      const { data, error } = await admin.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true });
      if (error) throw new HttpErr(400, error.message);
      await admin.from("profiles").insert({ id: data.user.id, name: body.name || "Admin", role: "admin" });
      return json({ ok: true });
    }

    const p = await me(req);
    if (a === "catalog") return json(await catalog(!!body.force));

    const getOrder = async (id: number) => {
      const { data: o } = await admin.from("orders").select("*").eq("id", id).single();
      if (!o) throw new HttpErr(404, "الأوردر مش موجود");
      return o;
    };
    const save = async (o: any, patch: any) => {
      const { data, error } = await admin.from("orders").update(patch).eq("id", o.id).eq("status", o.status).select("id");
      if (error) throw new HttpErr(500, error.message);
      if (!data?.length) throw new HttpErr(409, "الأوردر اتغيّر من حد تاني — اعمل تحديث");
    };

    if (a === "create_order") {
      need(p, ["admin", "moderator"]);
      const b = body.order || {};
      const items = (b.items || []).map((i: any) => ({ item_id: i.item_id, variant_id: i.variant_id, name: i.name, color: i.color || "", sku: i.sku || "", price: Number(i.price), qty: Number(i.qty) }));
      if (!items.length || items.some((i: any) => !i.variant_id || !(i.qty > 0) || !(i.price >= 0))) throw new HttpErr(400, "المنتجات مش صحيحة");
      const subtotal = items.reduce((s: number, i: any) => s + i.price * i.qty, 0);
      const row = { customer_name: String(b.customer_name || "").trim(), phone: b.phone, phone2: b.phone2 || null, address: String(b.address || "").trim(),
        zone: b.zone, city: b.city, shipping_fee: Number(b.shipping_fee), items, subtotal, deposit: Number(b.deposit || 0),
        contents: b.contents, notes: b.notes || null, created_by: p.id, status: "new" };
      const { data: o, error } = await admin.from("orders").insert(row).select().single();
      if (error) throw new HttpErr(400, "البيانات ناقصة أو غلط: " + error.message);
      try {
        // receipt deducts the stock in Loyverse immediately
        const rn = await createReceipt(o, items);
        await admin.from("orders").update({ receipt_number: rn, stock_deducted: true }).eq("id", o.id);
        return json({ ok: true, id: o.id, receipt: rn });
      } catch (e) {
        await admin.from("orders").delete().eq("id", o.id);
        throw new HttpErr(502, "الأوردر متسجلش لأن الفاتورة معرفتش تتعمل في Loyverse: " + (e as Error).message);
      }
    }

    if (a === "set_status") {
      const o = await getOrder(body.order_id);
      const to = body.status;
      if (to === "confirmed") {
        if (o.status !== "new") throw new HttpErr(400, "الأوردر مش في حالة جديد");
        const legacy = !o.receipt_number && !o.stock_deducted; // old order saved without receipt
        if (legacy) await adjustStock(o.items, -1);
        await save(o, { status: "confirmed", confirmed_by: p.id, confirmed_at: now(), ...(legacy ? { stock_deducted: true } : {}) });
        return json({ ok: true });
      }
      if (to === "prepared") {
        if (o.status !== "confirmed") throw new HttpErr(400, "لازم الأوردر يكون مؤكد الأول");
        await save(o, { status: "prepared", prepared_by: p.id, prepared_at: now() });
        return json({ ok: true });
      }
      if (to === "cancelled") {
        if (!["new", "confirmed", "prepared"].includes(o.status)) throw new HttpErr(400, "مينفعش يتلغي في الحالة دي");
        if (o.status !== "new") need(p, ["admin"]);
        if (o.stock_deducted || o.receipt_number) await adjustStock(o.items, 1); // pieces go back to stock automatically
        await save(o, { status: "cancelled", stock_deducted: false });
        return json({ ok: true });
      }
      if (to === "back") { // one step back
        need(p, ["admin"]);
        const prev: any = { prepared: "confirmed", shipping: "prepared" }[o.status as string];
        if (!prev) throw new HttpErr(400, "مينفعش");
        await save(o, { status: prev, ...(prev === "prepared" ? { shipped_at: null } : { prepared_at: null }) });
        return json({ ok: true });
      }
      throw new HttpErr(400, "حالة غير معروفة");
    }

    if (a === "export") {
      need(p, ["admin"]);
      const ids: number[] = (body.ids || []).map(Number);
      if (!ids.length) throw new HttpErr(400, "اختار أوردرات الأول");
      const { data: os } = await admin.from("orders").select("*").in("id", ids).eq("status", "prepared").order("id");
      if (!os?.length) throw new HttpErr(400, "الأوردرات دي مش في تم التجهيز");
      await admin.from("orders").update({ status: "shipping", shipped_at: now() }).in("id", os.map((o) => o.id)).eq("status", "prepared");
      return json({ orders: os });
    }

    if (a === "settle") {
      need(p, ["admin"]);
      const o = await getOrder(body.order_id);
      if (o.status !== "shipping") throw new HttpErr(400, "الأوردر مش مع شركة الشحن");
      const kind = body.kind;
      // returned quantities per variant
      const ret = new Map<string, number>();
      if (kind === "returned") for (const it of o.items) ret.set(it.variant_id, (ret.get(it.variant_id) || 0) + Number(it.qty));
      if (kind === "partial") for (const r of body.returned || []) if (Number(r.qty) > 0) ret.set(r.variant_id, (ret.get(r.variant_id) || 0) + Number(r.qty));
      const kept: any[] = [], back: any[] = [];
      for (const it of o.items) {
        const rq = Math.min(Number(it.qty), ret.get(it.variant_id) || 0);
        ret.set(it.variant_id, (ret.get(it.variant_id) || 0) - rq);
        if (Number(it.qty) - rq > 0) kept.push({ ...it, qty: Number(it.qty) - rq });
        if (rq > 0) back.push({ ...it, qty: rq });
      }
      if (kind === "partial" && (!back.length || !kept.length)) throw new HttpErr(400, "في الاستلام الجزئي لازم يبقى فيه منتج راجع ومنتج مستلم");
      if (!["collected", "returned", "partial"].includes(kind)) throw new HttpErr(400, "نوع غير معروف");
      const keptSub = kept.reduce((s, l) => s + Number(l.price) * Number(l.qty), 0);
      const net = kind === "returned" ? 0 : (body.net_amount != null && body.net_amount !== "" ? Number(body.net_amount) : keptSub - Number(o.deposit));
      let receipt: string | null = o.receipt_number;
      if (o.receipt_number) {
        // receipt was made on save: put the returned pieces back in stock
        if (back.length) await adjustStock(back, 1);
      } else {
        // legacy order: receipt for what was actually sold, then release the reservation
        if (kept.length) receipt = await createReceipt(o, kept);
        if (o.stock_deducted) await adjustStock(o.items, 1);
      }
      await save(o, { status: kind, settled_at: now(), settled_by: p.id, net_amount: net, returned_items: back.length ? back : null,
        receipt_number: receipt, stock_deducted: false });
      return json({ ok: true, receipt });
    }

    if (a === "users") {
      need(p, ["admin"]);
      const { data: ps } = await admin.from("profiles").select("*").order("created_at");
      const { data: us } = await admin.auth.admin.listUsers({ perPage: 1000 });
      const em = new Map(us.users.map((u) => [u.id, u.email]));
      return json({ users: (ps || []).map((x) => ({ ...x, email: em.get(x.id) })) });
    }
    if (a === "create_user") {
      need(p, ["admin"]);
      if (!body.password || body.password.length < 6) throw new HttpErr(400, "الباسورد لازم ٦ حروف على الأقل");
      const { data, error } = await admin.auth.admin.createUser({ email: body.email, password: body.password, email_confirm: true });
      if (error) throw new HttpErr(400, error.message);
      await admin.from("profiles").insert({ id: data.user.id, name: body.name, role: body.role || "moderator" });
      return json({ ok: true });
    }
    if (a === "update_user") {
      need(p, ["admin"]);
      if (body.id === p.id && body.role && body.role !== "admin") throw new HttpErr(400, "مينفعش تشيل الأدمن من نفسك");
      if (body.role) await admin.from("profiles").update({ role: body.role }).eq("id", body.id);
      if (body.password) {
        const { error } = await admin.auth.admin.updateUserById(body.id, { password: body.password });
        if (error) throw new HttpErr(400, error.message);
      }
      return json({ ok: true });
    }
    throw new HttpErr(400, "action?");
  } catch (e) {
    return json({ error: e instanceof HttpErr ? e.message : String(e) }, e instanceof HttpErr ? e.status : 500);
  }
});
