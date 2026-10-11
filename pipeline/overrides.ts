// Hand-encoded facts the parser can't read (opening hours, no-entry windows), keyed by ahuzot.co.il ID.
// ponytail: keyed by ID, not by text; re-check these when a lot's hours text changes on the site.
import type { Lot } from "../src/engine.ts";
import { SUN_THU } from "./parse.ts";

// "בהתאם לשילוט" lots: open municipal lots where the traffic sign rules (GIS layers 488/970 say free).
// Evidence: research/FINDINGS_2026-10-04.md. Re-check with Street View before upgrading any to verified.
const sign = (free: boolean, he: string, en: string) => ({ sign: { free, he, en } });
const FREE = sign(true, "חניון עירוני פתוח, חינם לפי נתוני העירייה (לא מאומת). בדקו את התמרור בכניסה.",
  "Open municipal lot, free per Tel Aviv GIS data (unverified). Check the traffic sign at the entrance.");
const FREE_REVIEWS = sign(true, "חניון עירוני פתוח, חינם לפי נתוני העירייה וביקורות גולשים (לא מאומת). בדקו את התמרור בכניסה.",
  "Open municipal lot, free per Tel Aviv GIS data and visitor reviews (unverified). Check the traffic sign at the entrance.");
const signs: Record<number, Partial<Lot>> = {
  ...Object.fromEntries([56, 64, 110, 85, 88, 87, 54, 55, 89, 76, 58, 62, 65, 81, 67, 69, 63, 91, 90].map((id) => [id, FREE])),
  ...Object.fromEntries([72, 80, 79, 77, 70].map((id) => [id, FREE_REVIEWS])),
  57: sign(false, "ביום: תשלום לפי תעריף כחול-לבן (פנגו/סלו). מ-17:00: לבעלי תו אזור 4 בלבד. לפי ביקורות, לא מאומת.",
    "Daytime: blue-white street rate (pay by Pango/Cello). From 17:00: zone-4 resident permits only. Per reviews, unverified."),
  68: sign(false, "חלק בתשלום (מגודר, עם קופה) וחלק עפר בחינם. לפי ביקורת מ-2025, לא מאומת.",
    "Part paid (barrier + pay machine), part free dirt lot. Per a 2025 review, unverified."),
  75: sign(false, "בפועל לתושבי האזור בלבד, לפי ביקורות. לא מאומת.", "Effectively residents only, per reviews. Unverified."),
  138: sign(false, "נתונים סותרים: העירייה מציגה גם תעריף בתשלום (₪16 לשעה הראשונה) וגם חניה חינם. בדקו את השילוט.",
    "Conflicting data: the city lists both a paid tariff (₪16 first hour) and free parking. Check the sign."),
  133: sign(false, "אין מידע על המחיר. בדקו את השילוט בכניסה.", "No price information. Check the sign at the entrance."),
};

export const overrides: Record<number, Partial<Lot>> = {
  ...signs,
  // HaTarbut / Habima: no entry 20:00-21:00 Sun-Thu & Sat, 12:00-13:00 Fri
  94: { no_entry: [{ days: [...SUN_THU, "sat"], from: "20:00", to: "21:00" }, { days: ["fri"], from: "12:00", to: "13:00" }] },
  // Smolarz: Sun-Thu 07-23, Fri & holiday eves 07-14, closed Shabbat; cars can't exit when closed
  95: { open: [{ days: SUN_THU, from: "07:00", to: "23:00" }, { days: ["fri", "holiday_eve"], from: "07:00", to: "14:00" }] },
  // Museums: as above plus Sat & holidays 08-18
  121: {
    open: [
      { days: SUN_THU, from: "07:00", to: "23:00" },
      { days: ["fri", "holiday_eve"], from: "07:00", to: "14:00" },
      { days: ["sat", "holiday"], from: "08:00", to: "18:00" },
    ],
  },
  // Gan HaKovshim 2 West: closed for mosque worshippers Fri 07-15
  129: {
    open: [
      { days: [...SUN_THU, "sat", "holiday_eve", "holiday"], from: "00:00", to: "00:00" },
      { days: ["fri"], from: "00:00", to: "07:00" },
      { days: ["fri"], from: "15:00", to: "00:00" },
    ],
  },
};
