// Private operators. Central Park: structured price lists in their Next.js pages (gate + app price).
// Green Parking: free-text price blocks that differ per lot, so the TLV lots are hand-encoded below and
// the build flags any change in a lot's text, and any new lot.
import { setTimeout as sleep } from "node:timers/promises";
import { WEEK, type Day, type Lot, type Rule, type Sub } from "../src/engine.ts";
import { SUN_THU } from "./parse.ts";

type Get = (url: string) => Promise<string>;
const FRI_SAT: Day[] = ["fri", "sat"];
const DAYNAME = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HEB = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

// Next.js flight data (the page's server payload) as one string
const flight = (h: string) =>
  [...h.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => JSON.parse(`"${m[1]}"`)).join("");
// the balanced JSON object/array starting at s[i]
function jsonAt(s: string, i: number): any {
  if (i < 0) return undefined;
  let depth = 0, str = false;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (str) { if (c === "\\") j++; else if (c === '"') str = false; continue; }
    if (c === '"') str = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return JSON.parse(s.slice(i, j + 1));
  }
}

const SUB_TYPE: Record<string, Sub["type"]> = { Regular: "full", Night: "night", WeekdaySundayThursday: "weekdays", Motorcycle: "motorcycle", Saved: "reserved" };
const SUB_PERIOD: Record<string, Sub["period"]> = { Monthly: "month", Weekly: "week" };

export async function centralPark(get: Get, today: string, problems: string[]): Promise<Lot[]> {
  const list = flight(await get("https://centralpark.co.il/he/parking"));
  const all = jsonAt(list, list.indexOf('"parkingLots":[') + '"parkingLots":'.length) ?? [];
  const tlv = all.filter((l: any) => l.cityDto?.code === 5000); // Tel Aviv-Yafo
  if (tlv.length < 25) problems.push(`centralpark: only ${tlv.length} TLV lots on centralpark.co.il/he/parking (expected ~35)`);
  const lots: Lot[] = [];
  for (const l of tlv) {
    await sleep(1000);
    const source_url = `https://centralpark.co.il/he/parking/${l.id}`;
    const f = flight(await get(source_url));
    const d = jsonAt(f, f.indexOf('{"parkingLotDynamicInfo"'));
    const pls: any[] = d?.parkingLotDynamicInfo?.priceLists ?? [];
    const name = l.name.trim().startsWith("חניון") ? l.name.trim() : `חניון ${l.name.trim()}`;
    if (!pls.length) { problems.push(`centralpark-${l.id} ${name}: no price list`); continue; }
    if (pls.some((p) => !DAYNAME.includes(p.startDayCombinedDto) || !DAYNAME.includes(p.endDayCombinedDto))) {
      problems.push(`centralpark-${l.id} ${name}: unknown day name in price list`); continue;
    }
    const rules = (app: boolean): Rule[] => pls.map((p) => {
      const days: Day[] = [];
      for (let i = DAYNAME.indexOf(p.startDayCombinedDto); ; i = (i + 1) % 7) { days.push(WEEK[i]); if (DAYNAME[i] === p.endDayCombinedDto) break; }
      const pick = (base: number | null, appPrice: number | null) => (app ? appPrice ?? base : base) ?? undefined;
      const hour = pick(p.basePriceHour, p.appPriceHour), max = pick(p.baseMaxPricePerDay, p.appMaxPricePerDay);
      const w = { days, from: p.startTime.slice(0, 5), to: p.endTime.slice(0, 5) };
      return p.template === "Fixed" || hour == null
        ? { ...w, kind: "flat", price: max, valid_until: p.fixedPriceListText?.match(/\d\d:\d\d/)?.[0] }
        : { ...w, kind: "step", first_hour: hour, step_minutes: 60, step_price: pick(p.basePriceSecondHour, p.appPriceSecondHour) ?? hour, daily_max: max };
    });
    const ils = (base: number | null, app: number | null) => (base == null ? "" : `₪${base}${app != null && app !== base ? ` (באפליקציה ₪${app})` : ""}`);
    const tariff_text = pls.map((p) => `${p.title} ${p.startTime.slice(0, 5)}–${p.endTime.slice(0, 5)}: ` + (p.template === "Fixed" || p.basePriceHour == null
      ? `${p.fixedPriceListText ?? "כניסה חד פעמית"} ${ils(p.baseMaxPricePerDay, p.appMaxPricePerDay)}`
      : `שעה ראשונה ${ils(p.basePriceHour, p.appPriceHour)}, כל שעה נוספת ${ils(p.basePriceSecondHour, p.appPriceSecondHour)}, ` +
        `חניה יומית ${ils(p.baseMaxPricePerDay, p.appMaxPricePerDay)}`)).join("\n");
    // schedule: per weekday opening/closing time (equal = 24h), nulls = closed that day
    const sched: any[] = d.parkingLotStaticInfo?.parkingLotSchedule ?? [];
    const open = sched.filter((s) => s.openingTime && s.closingTime)
      .map((s) => ({ days: [WEEK[DAYNAME.indexOf(s.day)]], from: s.openingTime.slice(0, 5), to: s.closingTime.slice(0, 5) }));
    const always = sched.length === 7 && open.length === 7 && open.every((w) => w.from === w.to);
    const desc = (s: any) => !s.openingTime ? "סגור" : s.openingTime === s.closingTime ? "24 שעות" : `${s.openingTime.slice(0, 5)}–${s.closingTime.slice(0, 5)}`;
    const subscriptions: Sub[] = [];
    for (const s of d.subscriptionPriceListDtos ?? []) {
      if (!(s.priceNis > 0)) continue; // 0 = "subscriptions not available at this lot"
      const type = /ראשון עד חמישי|א'-ה'/.test(s.text ?? "") ? "weekdays" : SUB_TYPE[s.subscriptionType], period = SUB_PERIOD[s.periodType];
      if (!type || !period) { problems.push(`centralpark-${l.id} ${name}: unknown subscription ${s.subscriptionType}/${s.periodType}`); continue; }
      subscriptions.push({ type, period, price_ils: s.priceNis, text: s.text?.trim() || undefined, source: "operator" });
    }
    const extra = d.parkingLotExtraDetailsDto ?? {}, props: any[] = d.parkingLotStaticInfo?.parkingLotProperties ?? [];
    // "Electric loading" flag without a count = at least one charger. A height limit means a structure, so covered.
    const ev = (extra.chargingStations ?? 0) + (extra.fastChargingStations ?? 0) || (props.some((p) => p.propertyKey === "Electric loading") ? 1 : 0);
    lots.push({
      id: `centralpark-${l.id}`, name, operator: "centralpark", address: l.address, lat: l.lat, lng: l.lon,
      spaces: d.parkingLotExtraDetailsDto?.totalSpots ?? undefined,
      ...(ev && { ev_chargers: ev }), ...(extra.heightLimit && { height_m: extra.heightLimit, covered: true }),
      hours_text: always ? "פתוח 24 שעות" : sched.map((s) => `${HEB[DAYNAME.indexOf(s.day)]} ${desc(s)}`).join(" · "),
      tariff_text, tariffs: rules(false), app_tariffs: rules(true), ...(subscriptions.length && { subscriptions }), ...(sched.length && !always && { open }), source_url, verified_at: today,
    });
  }
  return lots;
}

// Green Parking TLV lots, keyed by WordPress post id; null = outside Tel Aviv-Yafo or skipped.
// `text` is the site's price block as of 2026-10-04: when it changes, re-read it and re-encode `tariffs`.
// Reading used throughout: "שישי שבת ₪X" = flat X per entry from 06:00 to 06:00 (as lot 1969 spells out).
const step = (days: Day[], from: string, to: string, first_hour: number, step_price: number, daily_max: number): Rule =>
  ({ days, from, to, kind: "step", first_hour, step_minutes: 15, step_price, daily_max });
const flat = (days: Day[], from: string, to: string, price: number): Rule => ({ days, from, to, kind: "flat", price });
type G = Pick<Lot, "name" | "address" | "lat" | "lng" | "tariffs" | "sign"> & { text: string };
const GREEN: Record<number, G | null> = {
  2353: { name: "חניון עין יעקב", address: "עין יעקב 25", lat: 32.06344, lng: 34.76441,
    text: "דקה 1-180 - ₪0.25 / דקה 181-220 - ₪0.25 / חניה יומית / ₪55 / אובדן כרטיס / 100 ₪ / שישי שבת",
    tariffs: [{ days: WEEK, from: "00:00", to: "00:00", kind: "per_minute", rate: 15, daily_max: 55 }] },
  2288: { name: "חניון האופרה", address: "הירדן 2", lat: 32.07418, lng: 34.76561,
    text: "דקה 1-60 - ₪0.50 / דקה 61-240 - ₪0.50 / חניה יומית / ₪120 / אובדן כרטיס / 300 ₪ / שישי שבת",
    tariffs: [{ days: WEEK, from: "00:00", to: "00:00", kind: "per_minute", rate: 30, daily_max: 120 }] },
  2142: { name: "חניון בן יהודה 11", address: "בן יהודה 11", lat: 32.07468, lng: 34.76791,
    text: "שעה ראשונה או חלק ממנה - ₪25 / כל רבע שעה נוספת או חלק ממנה - ₪7 / חניה יומית / ₪90 / אובדן כרטיס / 100 ₪ / שישי שבת",
    tariffs: [step(WEEK, "00:00", "00:00", 25, 7, 90)] },
  1969: { name: "חניון דוד חכמי 16", address: "דוד חכמי 16", lat: 32.06335, lng: 34.78201,
    text: "שעה ראשונה או חלק ממנה - ₪18 / כל רבע שעה נוספת או חלק ממנה - ₪6 / חניה יומית / ₪70 / אובדן כרטיס / 100 ליום ₪ / שישי שבת / שישי או שבת מהשעה 6:00 ועד השעה 6:00 למחרת. 25 ש\"ח ₪ / בימי חול, כניסה משעה 19:00: מחיר קבוע 20 ש״ח",
    tariffs: [flat(FRI_SAT, "06:00", "06:00", 25), flat(SUN_THU, "19:00", "06:00", 20), step(SUN_THU, "06:00", "19:00", 18, 6, 70)] },
  1966: { name: "חניון בית גאון", address: "יחזקאל קויפמן 6", lat: 32.064, lng: 34.76248,
    text: "שעה ראשונה או חלק ממנה - ₪18 / כל רבע שעה נוספת או חלק ממנה - ₪6 / חניה יומית / ₪64 / אובדן כרטיס / 100 ₪ / שישי שבת / 25 ₪ / החל משעה 18:00 - 30 ₪ (עד השעה 06:00 בבוקר)",
    tariffs: [flat(FRI_SAT, "06:00", "06:00", 25), flat(WEEK, "18:00", "06:00", 30), step(SUN_THU, "06:00", "18:00", 18, 6, 64)] },
  1594: { name: "חניון בלומפילד משטרה", address: "עציון גבר 7", lat: 32.0539, lng: 34.76155,
    text: "שעה ראשונה או חלק ממנה - ₪20 / כל רבע שעה נוספת או חלק ממנה - ₪6 / חניה יומית / ₪54 / אובדן כרטיס / 100 ₪ / שישי שבת / החל משעה 18:00 - ₪25",
    tariffs: [flat(WEEK, "18:00", "06:00", 25), step(WEEK, "06:00", "18:00", 20, 6, 54)] },
  541: { name: "חניון התלמי (נווה צדק)", address: "יהושע התלמי 16", lat: 32.06268, lng: 34.76863,
    text: "דקה 1-60 - ₪0.35 / דקה 61-180 - ₪0.40 / דקה 181-240 - ₪0.30 / חניה יומית / ₪87 / אובדן כרטיס / 300 ₪ / שישי שבת / - ביום שישי תשלום כמו ביום רגיל, בשבת 30 ₪ / כניסה משעה 19:00: 0.35 ש״ח לדקה, מקסימום לערב 50 ש״ח",
    tariffs: [flat(["sat"], "06:00", "06:00", 30),
      { days: WEEK, from: "19:00", to: "06:00", kind: "per_minute", rate: 21, daily_max: 50 }, // ponytail: "max per evening" modelled as a 24h cap from entry
      { days: WEEK, from: "06:00", to: "19:00", kind: "per_minute", tiers: [[60, 21], [180, 24]], rate: 18, daily_max: 87 }] },
  537: { name: "חניון גינת השרון / גן החשמל", address: "לבונטין 10", lat: 32.06159, lng: 34.77487,
    text: "שעה ראשונה או חלק ממנה - ₪28 / כל רבע שעה נוספת או חלק ממנה - ₪7 / חניה יומית / ₪93 / אובדן כרטיס / 100 ליום ₪ / שישי שבת / כניסה משעה 19:00: שעה ראשונה 28 ש״ח, מקסימום לערב 50 ש״ח",
    tariffs: [step(WEEK, "19:00", "06:00", 28, 7, 50), step(WEEK, "06:00", "19:00", 28, 7, 93)] }, // ponytail: evening step rate assumed = daytime rate; "max per evening" = 24h cap from entry
  440: { name: "חניון סינמטק – קרליבך", address: "קרליבך 37", lat: 32.06994, lng: 34.78253,
    text: "שעה ראשונה או חלק ממנה - ₪22 / כל רבע שעה נוספת או חלק ממנה - ₪7 / חניה יומית / ₪80 / אובדן כרטיס / 300 ₪ / שישי שבת / 25 ₪ / כניסה משעה 20:00 (עד 06:00 למחרת) 30ש\"ח",
    tariffs: [flat(FRI_SAT, "06:00", "06:00", 25), flat(WEEK, "20:00", "06:00", 30), step(SUN_THU, "06:00", "20:00", 22, 7, 80)] },
  433: { name: "חניון אומנויות הבמה / לויד ג'ורג'", address: "לויד ג'ורג' 5", lat: 32.06615, lng: 34.78155,
    text: "דקה 1-30 - ₪0.50 / דקה 31-180 - ₪0.40 / דקה 181-240 - ₪0.20 / חניה יומית / ₪87 / אובדן כרטיס / 300 ₪ / שישי שבת / 25 ₪ / כניסה משעה 20:00 (עד למחרת ב 06:00) - 32 ש\"ח",
    tariffs: [flat(FRI_SAT, "06:00", "06:00", 25), flat(WEEK, "20:00", "06:00", 32),
      { days: SUN_THU, from: "06:00", to: "20:00", kind: "per_minute", tiers: [[30, 30], [180, 24]], rate: 12, daily_max: 87 }] },
  424: { name: "חניון הכרמל", address: "סמטת הכרמל 1", lat: 32.06741, lng: 34.76731,
    text: "חניה יומית / אובדן כרטיס / שישי שבת / המחיר משתנה לפי השילוט בכניסה * 30-80ש\"ח",
    tariffs: null, sign: { free: false, he: "המחיר לפי השילוט בכניסה (₪30–80 לפי אתר המפעיל).", en: "Price per the sign at the entrance (₪30-80 per the operator's site)." } },
  421: { name: "חניון המסגר", address: "חומה ומגדל 21", lat: 32.0633, lng: 34.78631,
    text: "שעה ראשונה 20 ₪ / כל רבע שעה 6 ₪ / חניה יומית / ₪50 / אובדן כרטיס / 100 ₪ / שישי שבת / כניסה משעה 18:00 עד 06:00 למחרת 25 ש\"ח",
    tariffs: [flat(WEEK, "18:00", "06:00", 25), step(WEEK, "06:00", "18:00", 20, 6, 50)] },
  2246: null, // "נווה צדק 2": same corner as 2353 (older listing, daily price only)
  1513: null, // בר כוכבא 4 is in Bnei Brak
  2252: null, 2167: null, 2147: null, 2105: null, 1471: null, 1350: null, 1054: null, 418: null, 413: null, 406: null, 324: null, // other cities
};

export const text = (h: string) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|span)>/g, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&#8362;/g, "₪").replace(/&#8211;/g, "–").replace(/&quot;|&#8221;|&#8220;/g, '"')
  .replace(/&#0?39;|&#8217;/g, "'").replace(/&amp;/g, "&").replace(/\s*\n\s*/g, "\n").replace(/[ \t]+/g, " ").trim();

export async function green(get: Get, today: string, problems: string[]): Promise<Lot[]> {
  const api = JSON.parse(await get("https://www.greenparking.co.il/wp-json/wp/v2/parkings?per_page=100"));
  const lots: Lot[] = [];
  for (const p of api) {
    const g = GREEN[p.id];
    if (g === undefined) { problems.push(`green ${p.id} "${text(p.title.rendered).trim()}": new lot, encode it in pipeline/operators.ts (null if outside TLV)`); continue; }
    if (!g) continue;
    await sleep(1000);
    const lines = text(await get(p.link)).split("\n").map((l) => l.trim()).filter(Boolean);
    const a = lines.findIndex((l) => /מחירון חניה/.test(l)), b = lines.findIndex((l, i) => i > a && /חשוב לדעת|ט\.ל\.ח|עשוי להשתנות/.test(l));
    const now = lines.slice(a + 1, b).join(" / ");
    if (a < 0 || b < 0 || now !== g.text) problems.push(`green-${p.id} ${g.name}: price text changed, re-encode it in pipeline/operators.ts:\n    ${now}`);
    const { text: t, ...lot } = g;
    lots.push({ id: `green-${p.id}`, operator: "green", ...lot, tariff_text: t.replaceAll(" / ", "\n"), source_url: decodeURIComponent(p.link), verified_at: today });
  }
  return lots;
}

// Single lots with a price list on their own site. `says` are phrases copied from the page; when one is gone the
// build flags it and `tariffs` must be re-read. Coordinates: the lot's entry in the city license registry (GIS 556).
const per_min = (days: Day[], from: string, to: string, rate: number, daily_max: number, tiers?: [number, number][]): Rule =>
  ({ days, from, to, kind: "per_minute", rate, daily_max, ...(tiers && { tiers }) });
const AZRIELI = "https://www.azrielimalls.co.il/malls/tel-aviv/useful-information";
const WEEKEND: Day[] = ["fri", "sat", "holiday"];
const SINGLE: (Omit<Lot, "verified_at"> & { says: string[] })[] = [
  { id: "dizengoff-center", name: "חניון דיזנגוף סנטר", operator: "dizengoff-center", address: "דיזנגוף 61", lat: 32.07556, lng: 34.77448,
    source_url: "https://www.dizengof-center.co.il/useful-info/parking",
    says: ["תעריף יום (כניסה משעה 06:00)", "שעה ראשונה 24 ש\"ח שעה שניה 15 ש\"ח כל שעה נוספת 15 ש\"ח מחיר מקסימלי 85 ש\"ח",
      "תעריף לילה בימי א-ה (כניסה משעה 18:00 יציאה עד 9:00) שעה ראשונה 24 ש\"ח שעה שניה 15 ש\"ח מחיר מקסימלי 35 ש\"ח",
      "בימי שישי יחל תעריף לילה לכניסה החל בשעה 16:00", "בחישוב לפי דקות"],
    // ponytail: the night cap ignores "exit by 09:00"; later exits are priced as one night
    tariffs: [per_min(SUN_THU, "18:00", "06:00", 15, 35, [[60, 24]]), per_min(["fri"], "16:00", "06:00", 15, 35, [[60, 24]]),
      per_min(SUN_THU, "06:00", "18:00", 15, 85, [[60, 24]]), per_min(["fri"], "06:00", "16:00", 15, 85, [[60, 24]]),
      per_min(["sat"], "06:00", "06:00", 15, 85, [[60, 24]])] },
  { id: "sarona-gindi", name: "חניון שרונה (גינדי)", operator: "sarona", address: "אלוף קלמן מגן 3", lat: 32.07134, lng: 34.7876,
    source_url: "https://www.saronaparking.co.il/",
    says: ["תעריף לדקה בין הדקות 1-30 ₪0.60", "החל מהדקה ה-31 ₪0.50", "חנייה יומית/אובדן כרטיס ₪115"],
    tariffs: [per_min(WEEK, "00:00", "00:00", 30, 115, [[30, 36]])] },
  { id: "azrieli-center", name: "חניון מרכז עזריאלי", operator: "azrieli", address: "דרך מנחם בגין 132", lat: 32.07387, lng: 34.79107,
    source_url: AZRIELI,
    says: ["תעריף לכל דקה: 40 אגורות. תעריף מקסימום ליום שלם: 100 ₪. לנכנסים בשעות 17:00-24:00, 40 אגורות לדקה עד מקסימום 25 ₪. שישי /שבת /חג -40 אגורות לדקה עד מקסימום 25 ₪."],
    tariffs: [per_min(WEEKEND, "00:00", "00:00", 24, 25), per_min(SUN_THU, "17:00", "00:00", 24, 25), per_min(SUN_THU, "00:00", "17:00", 24, 100)] },
  { id: "azrieli-sarona", name: "חניון עזריאלי שרונה", operator: "azrieli", address: "דרך מנחם בגין 121", lat: 32.07204, lng: 34.78899,
    source_url: AZRIELI,
    says: ["תעריף לכל דקה: 50 אגורות יום שלם 100 ₪ לנכנסים בשעות 18:00-24:00 , 50 אגורות לדקה עד מקסימום 25 ₪ שישי/שבת/חג 50 אגורות לדקה עד מקסימום 25 ₪"],
    tariffs: [per_min(WEEKEND, "00:00", "00:00", 30, 25), per_min(SUN_THU, "18:00", "00:00", 30, 25), per_min(SUN_THU, "00:00", "18:00", 30, 100)] },
  { id: "azrieli-town", name: "חניון עזריאלי טאון", operator: "azrieli", address: "דרך מנחם בגין 146", lat: 32.07831, lng: 34.79393,
    source_url: AZRIELI,
    says: ["תעריף לכל דקה: 50 אגורות. תעריף מקסימלי ליום שלם: 100 ₪. שישי/שבת/חג עד השעה 24:00, 50 אגורות לדקה עד מקסימום 25 ₪"],
    tariffs: [per_min(WEEKEND, "00:00", "00:00", 30, 25), per_min(SUN_THU, "00:00", "00:00", 30, 100)] },
];

// page text as one line; also unwraps the escaped JSON Azrieli embeds its mall data in
const oneLine = (h: string) => h.replace(/\\+r\\+n|\\+n/g, " ").replace(/\\+"/g, '"').replace(/<[^>]+>/g, " ")
  .replace(/&quot;/g, '"').replace(/&#8362;/g, "₪").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

export async function single(get: Get, today: string, problems: string[]): Promise<Lot[]> {
  const pages: Record<string, Promise<string>> = {};
  const lots: Lot[] = [];
  for (const { says, ...l } of SINGLE) {
    const page = oneLine(await (pages[l.source_url] ??= get(l.source_url)));
    const gone = says.filter((s) => !page.includes(s));
    if (gone.length) problems.push(`${l.id}: price text changed, re-read ${l.source_url} and fix pipeline/operators.ts. Missing:\n    ${gone.join("\n    ")}`);
    lots.push({ ...l, tariff_text: says.join("\n"), verified_at: today });
  }
  return lots;
}
