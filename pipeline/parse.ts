// Ahuzot tariff text (Hebrew) -> structured rules. Covers the templates seen on ahuzot.co.il;
// anything it can't cover fails the coverage check in build.ts so a human looks at it.
import { WEEK, type Day, type Rule } from "../src/engine.ts";

const LETTER: Record<string, number> = { "א": 0, "ב": 1, "ג": 2, "ד": 3, "ה": 4, "ו": 5, "ש": 6 };
export const ALL_DAYS: Day[] = [...WEEK, "holiday_eve", "holiday"], SUN_THU: Day[] = WEEK.slice(0, 5);
const pad = (t: string) => t.padStart(5, "0");

// "א` - ה`", "שישי (וערבי חג)", "שבת וחגים", "ו` וערבי חג" -> days
function parseDays(s: string): Day[] {
  const out = new Set<Day>();
  for (const [, a, b] of s.matchAll(/([אבגדהוש])[`'׳]\s*[-–]\s*([אבגדהוש])[`'׳]/g))
    for (let i = LETTER[a]; i <= LETTER[b]; i++) out.add(WEEK[i]);
  for (const [, a] of s.replace(/([אבגדהוש])[`'׳]\s*[-–]\s*([אבגדהוש])[`'׳]/g, "").matchAll(/(?:^|\s)([אבגדהוש])[`'׳]/g))
    out.add(WEEK[LETTER[a]]);
  if (/שישי/.test(s)) out.add("fri");
  if (/שבת/.test(s)) out.add("sat");
  if (/ערבי? חג/.test(s)) out.add("holiday_eve");
  if (/חג/.test(s.replace(/ערבי? חג/g, ""))) out.add("holiday");
  return [...out];
}

export type Parsed = {
  tariffs: Rule[] | null; resident_tariffs?: Rule[]; resident_discount_pct?: number;
  grace_minutes?: number; payment?: string[];
};

export function parseTariff(raw: string): Parsed {
  const text = raw.split(/שימו לב/)[0].replace(/\s+/g, " ");
  const out: Parsed = { tariffs: null };
  const pct = text.match(/(\d+)% הנחה לתושבי/);
  if (pct) out.resident_discount_pct = +pct[1];
  const grace = text.match(/עד (\d+) דקות ללא תשלום/);
  if (grace) out.grace_minutes = +grace[1];
  if (/לא ניתן לשלם במזומן/.test(raw)) out.payment = ["credit", "app"];
  if (/בהתאם לשילוט/.test(text)) return out;

  // sections start at "שעתי" (hourly) or a one-time entry price (flat)
  const markers = [...text.matchAll(/שעתי|תעריף לכניסה חד פעמית\s+(\d+)\s*₪|חד פעמי, (\d+)\s*₪/g)]
    .filter((m) => !/לפי תעריף $/.test(text.slice(0, m.index))) // "רכב הנכנס לפי תעריף שעתי" isn't a section
    .map((m) => ({ at: m.index!, flat: m[0] !== "שעתי", price: +(m[1] ?? m[2]) }));
  const clauses = [...text.matchAll(/(?:בימים|בימי|ובימי)\s+(.+?)\s+(?:בין השעות|מהשעה|משעה)\s+(\d{1,2}:\d\d).*?עד\s+(?:השעה\s+)?(\d{1,2}:\d\d)/g)]
    .map((m) => ({ at: m.index!, days: parseDays(m[1]), from: pad(m[2]), to: pad(m[3]) }));

  const rate = Number(text.match(/([\d.]+)\s*₪ לשעה/)?.[1]);
  const max = text.match(/מקסימום ליום\s+(\d+)/);
  const valid24 = /תקף ל-24 שעות/.test(text);
  const rules: Rule[] = [];
  markers.forEach((s, i) => {
    const end = markers[i + 1]?.at ?? text.length;
    const mine = clauses.filter((c) => c.at > s.at && c.at < end);
    if (!mine.length) {
      // no day clauses: whole week. A flat may say "תקף בין השעות 07:00 ... עד 07:00".
      const span = s.flat && !valid24 && text.slice(s.at, end).match(/בין השעות\s+(\d{1,2}:\d\d).*?עד\s+(\d{1,2}:\d\d)/);
      mine.push({ at: s.at, days: ALL_DAYS, from: span ? pad(span[1]) : "00:00", to: span ? pad(span[2]) : "00:00" });
    }
    for (const c of mine) {
      const w = { days: c.days, from: c.from, to: c.to };
      if (!s.flat) rules.push({ ...w, kind: "per_minute", rate, ...(max && { daily_max: +max[1] }) });
      else if (valid24 || c.from === "00:00" && c.to === "00:00") rules.push({ ...w, kind: "flat", price: s.price, valid_hours: 24 });
      else rules.push({ ...w, kind: "flat", price: s.price, valid_until: c.to });
    }
  });
  if (!rules.length) return out;
  // Once a lot mentions holiday eves/holidays, they follow Friday/Saturday rules unless stated.
  for (const [base, extra] of [["fri", "holiday_eve"], ["sat", "holiday"]] as const)
    if (rules.some((r) => r.days.includes(extra)))
      for (const r of rules) if (r.days.includes(base) && !r.days.includes(extra)) r.days.push(extra);
  out.tariffs = rules;

  // "עבור סטודנט / תושב ... תו אזורי 6.5 ₪ לשעה" / "... 22 ₪": a resident price instead of a %
  const res = text.match(/תו אזורי\s+([\d.]+)\s*₪/);
  if (res) out.resident_tariffs = rules.map((r) => (r.kind === "flat" ? { ...r, price: +res[1] } : { ...r, rate: +res[1] }));
  return out;
}
