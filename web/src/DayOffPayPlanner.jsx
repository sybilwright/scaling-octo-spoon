import { useState, useMemo, useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["S","M","T","W","T","F","S"];
const DOW = ["SU","MO","TU","WE","TH","FR","SA"];

// PSA Airlines domiciles this tool's user could be based out of, and the fixed US time-zone
// family each one sits in. Central and Eastern never drift relative to each other beyond a flat
// 60-minute offset (both observe DST on the same US schedule), so converting between them never
// needs real timezone-arithmetic/DST logic -- just add or subtract an hour based on family.
const BASES = [
  { code: "DFW", label: "Central – DFW", tzFamily: "CT" },
  { code: "CLT", label: "Eastern – CLT", tzFamily: "ET" },
  { code: "PHL", label: "Eastern – PHL", tzFamily: "ET" },
  { code: "DAY", label: "Eastern – DAY", tzFamily: "ET" },
  { code: "DCA", label: "Eastern – DCA", tzFamily: "ET" },
];
const BASE_TZ_FAMILY = new Map(BASES.map((b) => [b.code, b.tzFamily]));
const TZ_FAMILY_OFFSET_MIN = { CT: 0, ET: 60 }; // minutes east of Central

// Converts a "HH:MM" time reported at `fromBase` into the equivalent local time at `toBase`.
// Only Trade Board's CSV-export format carries a discoverable per-trip base (see
// parseTradeBoardPairingCell) -- everything else (the user's own Schedule, Opentime pot, and
// Trade Board's other two paste formats) has no base field to read, so is assumed to already be
// in the user's selected home-base zone and passes through unchanged.
function convertTimeToBase(time, fromBase, toBase) {
  if (!time || !fromBase || !toBase) return time;
  const fromFamily = BASE_TZ_FAMILY.get(fromBase);
  const toFamily = BASE_TZ_FAMILY.get(toBase);
  if (!fromFamily || !toFamily || fromFamily === toFamily) return time;
  const [h, m] = time.split(":").map(Number);
  const totalMin = h * 60 + m + (TZ_FAMILY_OFFSET_MIN[toFamily] - TZ_FAMILY_OFFSET_MIN[fromFamily]);
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }
function dateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }

function parseCreditToHours(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.includes(":")) {
    // "16:36", "6:36", or "16:6"/"6:6" with the leading zero on minutes left off -- split on
    // the colon itself rather than stripping it, since a compact hhmm reading can't tell "16:6"
    // (16h06m) apart from "166" (which the digit-only path below would misread as 1h66m).
    const parts = trimmed.split(":");
    if (parts.length !== 2) return null;
    const h = parseInt(parts[0].replace(/[^\d]/g, ""), 10);
    const m = parseInt(parts[1].replace(/[^\d]/g, ""), 10);
    if (isNaN(h) || isNaN(m)) return null;
    return h + m / 60;
  }
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  const p = digits.padStart(4, "0");
  const h = parseInt(p.slice(0, -2), 10);
  const m = parseInt(p.slice(-2), 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60;
}

function formatHours(h) {
  if (h == null || isNaN(h)) return "—";
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}:${pad2(mm)}`;
}
// formatHours alone mis-renders a negative fractional value (Math.floor(-6.5) = -7, so it prints
// "-7:30" instead of "-6:30") -- pull the sign off first, format the magnitude, then reattach.
function formatSignedHours(h) {
  if (h == null || isNaN(h)) return "—";
  return `${h < 0 ? "-" : h > 0 ? "+" : ""}${formatHours(Math.abs(h))}`;
}

function formatMoney(n) {
  return n.toLocaleString(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseDateToken(token, year) {
  const raw = String(token || "").trim();
  if (!raw) return null;
  const up = raw.toUpperCase();

  // "09SEP", "9 SEP", "09-SEP", "09-SEPT"
  let m = up.match(/^(\d{1,2})[\s-]*([A-Z]{3})[A-Z]*$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monIdx = MONTHS.indexOf(m[2]);
    if (monIdx !== -1 && day >= 1 && day <= 31) return { year, month: monIdx, day };
  }
  // "SEP 09", "SEP-9", "SEP-09-26" (Excel sometimes flips DD/MON on export)
  m = up.match(/^([A-Z]{3})[A-Z]*[\s-]*(\d{1,2})(?:[\s-]\d{2,4})?$/);
  if (m) {
    const monIdx = MONTHS.indexOf(m[1]);
    const day = parseInt(m[2], 10);
    if (monIdx !== -1 && day >= 1 && day <= 31) return { year, month: monIdx, day };
  }
  // "9/1", "9/1/2026", "9/1/26" — Excel auto-converts text dates to this
  m = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    let yr = year;
    if (m[3]) { yr = parseInt(m[3], 10); if (yr < 100) yr += 2000; }
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return { year: yr, month, day };
  }
  // "2026-09-01"
  m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const yr = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    const day = parseInt(m[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) return { year: yr, month, day };
  }
  return null;
}

function stripQuotes(s) { return String(s == null ? "" : s).trim().replace(/^"(.*)"$/, "$1"); }

function splitRow(line) {
  let cells;
  if (line.includes("\t")) cells = line.split("\t");
  else {
    const commaCount = (line.match(/,/g) || []).length;
    cells = commaCount >= 1 ? line.split(",") : line.split(/\s{2,}/);
  }
  return cells.map(stripQuotes);
}

function splitScheduleLine(line) {
  let cells;
  if (line.includes(",")) cells = line.split(",");
  else if (line.includes("\t")) cells = line.split("\t");
  else cells = line.split(/\s+/);
  return cells.map(stripQuotes);
}

function normalizeHeader(h) { return String(h || "").trim().toLowerCase(); }

function findCol(headers, keywords) {
  for (let i = 0; i < headers.length; i++) {
    if (keywords.some((k) => headers[i].includes(k))) return i;
  }
  return -1;
}

function normalizeTime(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*([AaPp])?\.?[Mm]?\.?/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const ap = m[3] ? m[3].toLowerCase() : null;
  if (ap === "p" && h < 12) h += 12;
  else if (ap === "a" && h === 12) h = 0;
  if (h > 23 || h < 0) return null;
  return `${pad2(h)}:${min}`;
}

// ---- Proper CSV parser (handles quoted fields with embedded commas/newlines) ----
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function parseColonHours(str) {
  const m = String(str || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) + parseInt(m[2], 10) / 60;
}

// FLICA's Trade Board export: pairing/date crammed into one cell (with an optional
// bracketed seniority list like " [7,8]"), and Days/Report/Depart/Arrive/Blk/Credit/Layover
// crammed into another with no reliable separators between some of them.
function parseTradeBoardPairingCell(cell) {
  const m = String(cell || "").trim().match(/^([A-Z0-9]+):(\d{1,2}[A-Z]{3})(?:\s*\[[\d,]+\])?([A-Z]{3})([A-Z]{2})$/i);
  if (!m) return null;
  return { pairing: m[1].toUpperCase(), dateTok: m[2].toUpperCase(), base: m[3].toUpperCase(), position: m[4].toUpperCase() };
}
function parseTradeBoardDetailCell(cell) {
  const text = String(cell || "");
  const daysMatch = text.match(/^(\d)/);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : 1;
  const timeMatches = [...text.matchAll(/\d{1,2}:\d{2}/g)];
  const times = timeMatches.map((m) => m[0]);
  const [report, depart, arrive, blk, creditColon] = times;
  let layover = "";
  if (timeMatches.length > 0) {
    const last = timeMatches[timeMatches.length - 1];
    layover = text.slice(last.index + last[0].length).replace(/\n+/g, " ").trim();
  }
  return { days, report: normalizeTime(report), depart: normalizeTime(depart), arrive: normalizeTime(arrive), blk: normalizeTime(blk), creditColon, layover };
}
function parseTradeBoardExport(text, year) {
  const rows = parseCSV(text);
  if (rows.length < 2) return { trips: [], error: "Couldn't find any trade board rows in that file." };
  const trips = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 3) continue;
    const p = parseTradeBoardPairingCell(row[1]);
    if (!p) continue;
    const d = parseTradeBoardDetailCell(row[2]);
    const creditHours = d.creditColon ? parseColonHours(d.creditColon) : null;
    const start = parseDateToken(p.dateTok, year);
    trips.push({
      id: `${p.pairing}-${p.dateTok}-${r}`,
      pairing: p.pairing, dateTok: p.dateTok, days: d.days, creditHours,
      layover: d.layover, start, autoTB: true, report: d.report, arrive: d.arrive, base: p.base,
    });
  }
  return { trips, error: trips.length === 0 ? "Found the file, but couldn't match any rows to the expected Trade Board export layout." : null };
}

// A raw copy-paste straight from the rendered Trade Board webpage (not an exported file at all) —
// each field lands on its own line in a fixed, repeating order per listing, anchored by the
// "PAIRING:DATE [seniority]" identity line. No CSV quoting involved here.
function parseTradeBoardRawPaste(text, year) {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const identityRe = /^([A-Z0-9]+):(\d{1,2}[A-Z]{3})(?:\s*\[[\d,]+\])?\s*$/i;
  const trips = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(identityRe);
    if (!m) continue;
    const pairing = m[1].toUpperCase();
    const dateTok = m[2].toUpperCase();
    const l2 = (lines[i + 2] || "").split("\t"); // days, report
    const l3 = (lines[i + 3] || "").split("\t"); // depart
    const l4 = (lines[i + 4] || "").split("\t"); // arrive, blk
    const l5 = (lines[i + 5] || "").split("\t"); // tpay (credit), layover
    const days = parseInt((l2[0] || "").trim(), 10) || 1;
    const report = normalizeTime((l2[1] || "").trim());
    const arrive = normalizeTime((l4[0] || "").trim());
    const creditHours = parseColonHours((l5[0] || "").trim());
    const layover = (l5[1] || "").trim();
    const start = parseDateToken(dateTok, year);
    if (!start || creditHours == null) continue;
    trips.push({
      id: `${pairing}-${dateTok}-${i}`,
      pairing, dateTok, days, creditHours, layover, start, autoTB: true, report, arrive,
    });
  }
  return { trips, error: trips.length === 0 ? "Found the text, but couldn't match any listings to the expected raw Trade Board paste layout." : null };
}

// FLICA glues an info-tooltip's text onto the pairing code with no separator for
// Trade-Board-sourced pairings when the Opentime pot page is copy-pasted, e.g.
// "W7F57Click to view TradeBoard request details." -- matching the exact known phrase
// (rather than guessing a boundary by letter case -- "Click" starts with an upper-case
// C too, indistinguishable from a real pairing character that way) strips it cleanly.
// This is a real, confirmed bug: without this, "TradeBoard" never matches \bTB\b (no
// word boundary between "e" and "B"), so these trips silently kept their default
// autoTB: false and could be offered as swap-ins/adds. Shared between the plain-paste
// parser and the screenshot/manual-row parser -- don't let those diverge again, a
// second real bug was this exact detection existing in one but not the other.
function stripTradeBoardTooltip(pairing) {
  let autoTB = false;
  // Browser copy-paste of the tooltip can carry non-breaking spaces ( ) instead of
  // regular ones -- normalize before matching, or the literal spaces in the pattern below
  // silently fail to line up and this whole check does nothing.
  const normalized = pairing.replace(/\s+/g, " ");
  const tbTooltipMatch = normalized.match(/^(.*?)click to view tradeboard request details\.?\s*$/i);
  if (tbTooltipMatch) { autoTB = true; pairing = tbTooltipMatch[1].trim(); }
  else if (/tradeboard/i.test(normalized)) { autoTB = true; } // an unexpected variant of the tooltip text -- still flag it even if we can't cleanly strip it
  return { pairing, autoTB };
}

// ---- Open Time / Trade Board table parser ----
function parseBoard(text, year) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return { trips: [], error: lines.length === 1 ? "Paste the header row plus at least one trip row." : "Paste the board's table, header row included." };

  let headerRowIdx = -1, idx = null;
  const maxHeaderScan = Math.min(lines.length - 1, 5);
  for (let h = 0; h < maxHeaderScan; h++) {
    const headerCells = splitRow(lines[h]).map(normalizeHeader);
    const candidate = {
      pairing: findCol(headerCells, ["pairing"]),
      dates: findCol(headerCells, ["date"]),
      days: findCol(headerCells, ["day"]),
      report: findCol(headerCells, ["report"]),
      arrive: findCol(headerCells, ["arriv"]),
      credit: findCol(headerCells, ["credit"]),
      blk: findCol(headerCells, ["blk", "block"]),
      layover: findCol(headerCells, ["layover"]),
    };
    if (candidate.pairing !== -1 && candidate.dates !== -1 && candidate.credit !== -1) {
      headerRowIdx = h; idx = candidate; break;
    }
  }

  if (headerRowIdx === -1) {
    const firstRowCells = splitRow(lines[0]).map(normalizeHeader);
    return { trips: [], error: `Couldn't find Pairing, Dates, and Credit columns (saw: ${firstRowCells.join(" | ") || "no header row detected"}).` };
  }

  const trips = [];
  for (let r = headerRowIdx + 1; r < lines.length; r++) {
    const cells = splitRow(lines[r]);
    if (cells.length < 3) continue;
    let pairing = (cells[idx.pairing] || "").trim();
    if (!pairing || normalizeHeader(pairing) === "pairing") continue;

    let autoTB;
    ({ pairing, autoTB } = stripTradeBoardTooltip(pairing));
    if (/\bTB\b/i.test(pairing)) { autoTB = true; pairing = pairing.replace(/\bTB\b/i, "").trim(); }
    if (cells.some((c) => normalizeHeader(c) === "tb")) autoTB = true;

    const dateTok = (cells[idx.dates] || "").trim();
    const daysRaw = idx.days > -1 ? (cells[idx.days] || "").trim() : "1";
    const days = parseInt(daysRaw, 10) || 1;
    const creditRaw = (cells[idx.credit] || "").trim();
    const layover = idx.layover > -1 ? (cells[idx.layover] || "").trim() : "";
    const report = idx.report > -1 ? normalizeTime(cells[idx.report]) : null;
    const arrive = idx.arrive > -1 ? normalizeTime(cells[idx.arrive]) : null;

    const start = parseDateToken(dateTok, year);
    const creditHours = parseCreditToHours(creditRaw);

    trips.push({
      id: `${pairing}-${dateTok}-${r}`,
      pairing, dateTok, days, creditHours, layover, start, autoTB, report, arrive,
    });
  }
  return { trips, error: trips.length === 0 ? "No usable rows found in that paste." : null };
}

const MAX_CONSECUTIVE_WORK_DAYS = 6;
const MIN_REST_HOURS = 10;
const GUARANTEE_HOURS = 75;

function adjacentDateKey(key, deltaDays) {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  return dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

// Hours between an end-of-duty time on one date and a report time on another (handles overnight).
function restHours(fromDateKey, fromTime, toDateKey, toTime) {
  if (!fromTime || !toTime) return null;
  const [fy, fm, fd] = fromDateKey.split("-").map(Number);
  const [fh, fmin] = fromTime.split(":").map(Number);
  const from = new Date(fy, fm - 1, fd, fh, fmin);
  const [ty, tm, td] = toDateKey.split("-").map(Number);
  const [th, tmin] = toTime.split(":").map(Number);
  const to = new Date(ty, tm - 1, td, th, tmin);
  return (to - from) / 3600000;
}

function longestConsecutiveRun(dateKeySet) {
  const dates = [...dateKeySet].sort();
  let maxRun = 0, curRun = 0, prev = null;
  for (const d of dates) {
    if (prev) {
      const diffDays = Math.round((new Date(d) - new Date(prev)) / 86400000);
      curRun = diffDays === 1 ? curRun + 1 : 1;
    } else {
      curRun = 1;
    }
    maxRun = Math.max(maxRun, curRun);
    prev = d;
  }
  return maxRun;
}

// Checks whether picking up candidateKeys would leave less than minGapDays of rest between it and
// the nearest EXISTING work day on either side. Recomputed fresh every time against whatever the
// current working-day set actually is — never a fixed block on specific calendar dates, only a
// live check of the actual gap around a candidate pickup.
function violatesMinRestGap(existingOccupiedKeys, candidateKeys, minGapDays) {
  if (!minGapDays || minGapDays < 1) return false;
  const candidateSet = new Set(candidateKeys);
  const existing = new Set([...existingOccupiedKeys].filter((k) => !candidateSet.has(k)));
  const sorted = [...candidateKeys].sort();
  if (!sorted.length) return false;
  const first = new Date(sorted[0]);
  const last = new Date(sorted[sorted.length - 1]);
  for (let d = 1; d <= minGapDays; d++) {
    const before = new Date(first); before.setDate(before.getDate() - d);
    if (existing.has(dateKey(before.getFullYear(), before.getMonth(), before.getDate()))) return true;
    const after = new Date(last); after.setDate(after.getDate() + d);
    if (existing.has(dateKey(after.getFullYear(), after.getMonth(), after.getDate()))) return true;
  }
  return false;
}

function tripDateKeys(trip) {
  if (!trip.start) return [];
  const keys = [];
  const d = new Date(trip.start.year, trip.start.month, trip.start.day);
  for (let i = 0; i < trip.days; i++) {
    keys.push(dateKey(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

// ---- Converts an editable row (from screenshot extraction or manual add) into a trip object ----
function rowToTrip(row, year) {
  const dateTok = (row.dateTok || "").trim();
  const start = parseDateToken(dateTok, year);
  const creditHours = parseCreditToHours(row.creditRaw);
  const days = parseInt(row.days, 10) || 1;
  let pairing = (row.pairing || "").trim();
  let autoTB = !!row.tb;
  const stripped = stripTradeBoardTooltip(pairing);
  pairing = stripped.pairing;
  if (stripped.autoTB) autoTB = true;
  if (/\bTB\b/i.test(pairing)) { autoTB = true; pairing = pairing.replace(/\bTB\b/i, "").trim(); }
  return {
    id: `img-${row.id}`,
    pairing, dateTok, days, creditHours,
    layover: row.layover || "",
    start, autoTB,
    report: normalizeTime(row.report),
    arrive: normalizeTime(row.arrive),
  };
}

// ---- Current schedule parser ----
function firstNumber(arr) {
  for (const c of arr) {
    const m = String(c || "").match(/-?\d+(\.\d+)?/);
    if (m) return parseFloat(m[0]);
  }
  return null;
}

// Some schedule exports flatten the whole month (and the whole stats block) onto one or two
// giant space-padded lines instead of one entry per line. Reconstruct real line breaks before
// a bare "one line per day" DOW+day-number pattern, and before each summary stat keyword.
// This is a no-op (harmless) on exports that are already one item per line.
function normalizeScheduleExport(text) {
  let t = text;
  t = t.replace(/[ ]+(Block|Credit|Days Off|TAFB|Duty Time|Carryover|Saturdays|Sundays|Weekends|YTD)\b/gi, "\n$1");
  t = t.replace(/\b(MO|TU|WE|TH|FR|SA|SU) +(\d{1,2})\b/g, "\n$1 $2");
  return t;
}

const VACATION_CREDIT_HOURS = 3;
const PED_CREDIT_HOURS = 3.5; // PED = Personal Emergency Day (paid)
const BEREAVEMENT_CREDIT_HOURS = 3.5;
// Every one of these is a protected day off -- never a valid pickup target, can never be worked
// over -- but they don't all carry the same credit. VAC/VAX and PED are each credited at their
// own flat rate; SICK/SIC/SNG/USIC/ING/PUD/MED carry no credit here at all -- not because they're
// unpaid, but because whether the sick bank actually covers them is unknowable from the schedule
// paste alone (see the sick-bank caveat note shown wherever SIC/USIC/MED appear). "ING" and
// "SICK" are the same thing under two different names FLICA uses depending on export/paste
// source, and so is PUD -- Personal Emergency Day Unpaid, i.e. the unpaid counterpart to PED,
// coded the same as SICK. BER is also 0 here for the same "can't tell from a flat map" reason --
// its real credit (flat for the first 3 days of a run, sick-bank-dispersed for any more) is
// computed separately by berGuaranteedCredit/berExtraDaySlots below, never read from this map.
const PROTECTED_DAY_CREDIT = { VAC: VACATION_CREDIT_HOURS, VAX: VACATION_CREDIT_HOURS, PED: PED_CREDIT_HOURS, SICK: 0, SIC: 0, SNG: 0, USIC: 0, ING: 0, PUD: 0, MED: 0, BER: 0 };

// Groups a schedule paste's BER-coded days into bereavement "occurrences", the same concept
// walkWorkingDayKeys used for the old manual tracker: a gap of ordinary already-off days between
// two BER-coded stretches doesn't start a new occurrence (bereavement was never going to need to
// cover a day that wasn't going to be worked anyway), but a gap containing a real WORKING day
// does. Needs the full scheduleParsed (protectedDayCodes for which days are BER, trips for which
// days actually have a trip on them) to tell the two kinds of gap apart.
function groupBerRuns(scheduleParsed) {
  const berKeys = [...(scheduleParsed.protectedDayCodes || new Map()).entries()].filter(([, c]) => c === "BER").map(([k]) => k).sort();
  if (!berKeys.length) return [];
  const workingKeys = new Set();
  (scheduleParsed.trips || []).forEach((t) => scheduleTripDateKeys(t).forEach((k) => workingKeys.add(k)));
  const runs = [];
  let current = [berKeys[0]];
  for (let i = 1; i < berKeys.length; i++) {
    let d = adjacentDateKey(berKeys[i - 1], 1);
    let brokenByWork = false;
    while (d !== berKeys[i]) {
      if (workingKeys.has(d)) { brokenByWork = true; break; }
      d = adjacentDateKey(d, 1);
    }
    if (brokenByWork) { runs.push(current); current = [berKeys[i]]; }
    else current.push(berKeys[i]);
  }
  runs.push(current);
  return runs;
}
// The first min(run.length, 3) days of every BER occurrence: always credited flat, no sick bank
// involved, straight from the schedule paste -- matches the guaranteed-3-days bereavement rule.
function berGuaranteedCredit(scheduleParsed) {
  return groupBerRuns(scheduleParsed).reduce((sum, run) => sum + Math.min(run.length, 3) * BEREAVEMENT_CREDIT_HOURS, 0);
}
// Day 4 and day 5 of every BER occurrence only -- the contractual cap on how many additional
// days bereavement can ever cover -- as dispersal slots ready to merge chronologically with
// Sick/MED entries for the shared Sick Start pool (see the sickDispersal computation below).
function berExtraDaySlots(scheduleParsed) {
  const slots = [];
  groupBerRuns(scheduleParsed).forEach((run) => {
    run.slice(3, 5).forEach((k) => slots.push({ dateKey: k, neededHours: BEREAVEMENT_CREDIT_HOURS }));
  });
  return slots;
}

function parseSchedule(text, year, month) {
  const rawLines = normalizeScheduleExport(text).split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const trips = [];
  const daysOff = new Set();
  const vacationDays = new Set();
  const protectedDayCodes = new Map();
  let summary = { credit: null, block: null, daysOffCount: null };
  let current = null;
  const pairingRe = /^[A-Z][A-Z0-9]{3,7}$/;

  for (const line of rawLines) {
    const tokens = splitScheduleLine(line);
    const first = (tokens[0] || "").trim().toLowerCase();

    if (first.startsWith("block")) { summary.block = firstNumber(tokens.slice(1).length ? tokens.slice(1) : [line]); continue; }
    if (first.startsWith("credit")) { summary.credit = firstNumber(tokens.slice(1).length ? tokens.slice(1) : [line]); continue; }
    if (first.startsWith("ytd")) continue;
    if (first.startsWith("days")) { summary.daysOffCount = firstNumber(tokens.slice(1).length ? tokens.slice(1) : [line]); continue; }

    if (tokens.length < 2) continue;
    const dow = tokens[0].toUpperCase();
    if (!DOW.includes(dow)) continue;
    const dayNum = parseInt(tokens[1], 10);
    if (!dayNum || dayNum < 1 || dayNum > 31) continue;

    let rest = tokens.slice(2).filter((x) => x !== "");
    if (rest.length && /^\d+(\.\d+)?$/.test(rest[rest.length - 1])) rest = rest.slice(0, -1);
    const key = dateKey(year, month, dayNum);

    if (rest.length === 1 && /^(VAC|VAX|PED|SICK|SIC|SNG|USIC|ING|PUD|MED|BER)$/i.test(rest[0])) {
      daysOff.add(key);
      vacationDays.add(key);
      protectedDayCodes.set(key, rest[0].toUpperCase());
      if (current) { trips.push(current); current = null; }
      continue;
    }

    if (rest.length === 0 || (rest.length === 1 && rest[0].toUpperCase() === "CI")) {
      daysOff.add(key);
      if (current) { trips.push(current); current = null; }
      continue;
    }

    const looksLikePairing = pairingRe.test(rest[0]) && /\d/.test(rest[0]);
    if (looksLikePairing) {
      if (current) trips.push(current);
      current = { pairing: rest[0], startYear: year, startMonth: month, startDay: dayNum, days: 1, destinations: [rest.slice(1).join(" ")] };
    } else if (current) {
      current.days += 1;
      current.destinations.push(rest.join(" "));
    }
  }
  if (current) trips.push(current);
  return { trips, daysOff, vacationDays, protectedDayCodes, summary };
}

function scheduleTripDateKeys(trip) {
  const keys = [];
  const d = new Date(trip.startYear, trip.startMonth, trip.startDay);
  for (let i = 0; i < trip.days; i++) {
    keys.push(dateKey(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setDate(d.getDate() + 1);
  }
  return keys;
}

// Reproduces the FLICA "one line per day" schedule format: DOW, day number, then a pairing
// code on the trip's first day and a destination on every day of the trip, blank if off.
// The Opentime pot's layover string only lists intermediate stops, never the final leg
// back to base — pad the remaining day(s) with the home base if one's been provided.
function buildDestinations(layover, days) {
  const dests = (layover || "").trim().split(/\s+/).filter(Boolean);
  while (dests.length < days) dests.push("RTB");
  return dests;
}

function renderFlicaCalendar(trips, daysOffCount, year, month, credit, block, blockMayBeInaccurate, vacationDates, protectedDayCodes) {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const byDay = new Map();
  trips.forEach((t) => {
    const d = new Date(t.startYear, t.startMonth, t.startDay);
    for (let i = 0; i < t.days; i++) {
      if (d.getFullYear() === year && d.getMonth() === month) {
        byDay.set(d.getDate(), { pairing: i === 0 ? t.pairing : null, dest: (t.destinations && t.destinations[i]) || "" });
      }
      d.setDate(d.getDate() + 1);
    }
  });
  const lines = [];
  for (let day = 1; day <= daysInMonth; day++) {
    const dow = DOW[new Date(year, month, day).getDay()];
    const entry = byDay.get(day);
    const dk = dateKey(year, month, day);
    if (vacationDates && vacationDates.has(dk)) lines.push(`${dow} ${pad2(day)} ${(protectedDayCodes && protectedDayCodes.get(dk)) || "VAC"}`);
    else if (!entry) lines.push(`${dow} ${pad2(day)}`);
    else if (entry.pairing) lines.push(`${dow} ${pad2(day)} ${entry.pairing} ${entry.dest}`.trimEnd());
    else lines.push(`${dow} ${pad2(day)}    ${entry.dest}`.trimEnd());
  }
  lines.push("");
  if (block != null) lines.push(`Block ${block}${blockMayBeInaccurate ? "  (may be incorrect)" : ""}`);
  if (credit != null) lines.push(`Credit ${credit}`);
  if (daysOffCount != null) lines.push(`Days Off ${daysOffCount}`);
  return lines.join("\n");
}

// ---- Reserve Grid parser ----
function parseReserveGrid(text, year) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < 2) return { grid: new Map(), error: "Paste or import the Reserve Grid table, header row included." };

  let headerRowIdx = -1, idx = null, rawHeaderCells = null;
  const maxHeaderScan = Math.min(lines.length - 1, 5);
  for (let h = 0; h < maxHeaderScan; h++) {
    let cells = splitRow(lines[h]);
    let normalized = cells.map(normalizeHeader);
    let dateIdx = findCol(normalized, ["date"]);
    let netIdx = findCol(normalized, ["net"]);
    let minIdx = findCol(normalized, ["min", "required", "buffer"]);
    if (dateIdx === -1 && netIdx !== -1 && minIdx !== -1) {
      // A merged/rowspan "Date" header from the title row above can leave this row's first
      // cell blank (CSV export) — Date is always the leftmost column, so fall back to it.
      if (!normalized[0]) {
        dateIdx = 0;
      } else if (h > 0) {
        // A raw copy/paste of the same rowspan table often drops the placeholder entirely
        // instead of leaving it blank, so this row is short by one cell. If the previous
        // scanned row's first cell is the "Date" header, treat this row as a continuation:
        // shift every index right by one and treat column 0 as the implicit Date column.
        const prevFirst = normalizeHeader(splitRow(lines[h - 1])[0] || "");
        if (prevFirst.includes("date")) {
          dateIdx = 0;
          netIdx += 1;
          minIdx += 1;
          cells = ["DATE", ...cells];
          normalized = ["date", ...normalized];
        }
      }
    }
    if (dateIdx !== -1 && netIdx !== -1 && minIdx !== -1) {
      headerRowIdx = h; idx = { date: dateIdx, net: netIdx, min: minIdx }; rawHeaderCells = cells; break;
    }
  }
  if (headerRowIdx === -1) {
    const firstRowCells = splitRow(lines[0]).map(normalizeHeader);
    return { grid: new Map(), error: `Couldn't find Date, Net Reserves, and Min Required columns (saw: ${firstRowCells.join(" | ") || "no header row detected"}).` };
  }

  const usedIdx = new Set([idx.date, idx.net, idx.min]);
  const usedColumns = [rawHeaderCells[idx.date] || "DATE", rawHeaderCells[idx.net], rawHeaderCells[idx.min]];
  const ignoredColumns = rawHeaderCells.filter((_, i) => !usedIdx.has(i));
  const grid = new Map();
  const attempted = lines.length - headerRowIdx - 1;
  for (let r = headerRowIdx + 1; r < lines.length; r++) {
    const cells = splitRow(lines[r]);
    if (cells.length < 3) continue;
    const parsed = parseDateToken((cells[idx.date] || "").trim(), year);
    if (!parsed) continue;
    const net = parseFloat((cells[idx.net] || "").replace(/[^\d.-]/g, ""));
    const min = parseFloat((cells[idx.min] || "").replace(/[^\d.-]/g, ""));
    if (isNaN(net) || isNaN(min)) continue;
    grid.set(dateKey(parsed.year, parsed.month, parsed.day), net > min ? "green" : net === min ? "black" : "red");
  }
  return {
    grid, usedColumns, ignoredColumns,
    error: grid.size === 0 ? `Found the columns, but couldn't read any of the ${attempted} row(s) below the header — check that the Date column looks like "09SEP" and Net Reserves / Min Required are plain numbers.` : null,
  };
}

// ---- "Days wanted off" free-text parser: "12,13,20,10/2" ----
function parseWantedDays(text, year, month, nextMonth, nextMonthYear) {
  const out = new Set();
  String(text || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((tok) => {
    const mmdd = tok.match(/^(\d{1,2})\/(\d{1,2})$/);
    if (mmdd) {
      const mo = parseInt(mmdd[1], 10) - 1;
      const day = parseInt(mmdd[2], 10);
      const yr = mo === nextMonth ? nextMonthYear : year;
      out.add(dateKey(yr, mo, day));
      return;
    }
    const dayOnly = tok.match(/^\d{1,2}$/);
    if (dayOnly) out.add(dateKey(year, month, parseInt(tok, 10)));
  });
  return out;
}

function MonthCalendar({ year, month, daysOff, wantedOff, onToggle }) {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ flex: "1 1 220px", minWidth: 220 }}>
      <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-dim)", marginBottom: 8 }}>{MONTH_NAMES[month]} {year}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 4 }}>
        {WEEKDAYS.map((w, i) => <div key={i} style={{ textAlign: "center", fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--mono)" }}>{w}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />;
          const key = dateKey(year, month, d);
          const isOff = daysOff.has(key);
          const isWanted = wantedOff.has(key);
          let border = "1px solid var(--line)";
          if (isOff && isWanted) border = "2px solid var(--amber)";
          else if (isOff) border = "1px solid var(--teal)";
          else if (isWanted) border = "1px dashed var(--amber)";
          return (
            <button key={i} onClick={() => onToggle(key)} style={{
              aspectRatio: "1", border, background: isOff ? "var(--cal-off-bg)" : "transparent",
              color: isOff ? "var(--teal-bright)" : isWanted ? "var(--amber)" : "var(--text)",
              borderRadius: 6, fontFamily: "var(--mono)", fontSize: 13, cursor: "pointer", padding: 0,
            }}>{d}</button>
          );
        })}
      </div>
    </div>
  );
}

const scheduleExample = `TU 01 W7805 HSV
WE 02 DFW
SA 05
SU 06

Block 72.23
Credit 81.49
YTD 495.41
Days Off 10`;

const boardExample = `Pairing\tDates\tDays\tReport\tDepart\tArrive\tBlk Hrs\tCredit\tLayover
W7G61\t09SEP\t4\t10:02\t10:47\t15:22\t1521\t1636\tTYS PIA DAY`;

const gridExample = `DATE\tAVAILABLE RESERVES\tOPEN DUTY PERIODS\tNET RESERVES\tMIN REQUIRED (BUFFER)
09SEP\t43\t5\t38\t30
13SEP\t53\t21\t32\t32`;

export default function DayOffPayPlanner({ session }) {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [rate, setRate] = useState("27.06");
  const [baselineCredit, setBaselineCredit] = useState("");
  const [daysOff, setDaysOff] = useState(new Set());
  const [wantedText, setWantedText] = useState("");
  const [wantedWeekdays, setWantedWeekdays] = useState(new Set());
  const [maxConsecutiveDaysPref, setMaxConsecutiveDaysPref] = useState(String(MAX_CONSECUTIVE_WORK_DAYS));
  const effectiveMaxConsecutive = useMemo(() => {
    const n = parseInt(maxConsecutiveDaysPref, 10);
    return (!isNaN(n) && n >= 1 && n <= MAX_CONSECUTIVE_WORK_DAYS) ? n : MAX_CONSECUTIVE_WORK_DAYS;
  }, [maxConsecutiveDaysPref]);
  const [minRestDaysPref, setMinRestDaysPref] = useState("");
  const effectiveMinRestDays = useMemo(() => {
    const n = parseInt(minRestDaysPref, 10);
    return (!isNaN(n) && n >= 1) ? n : 0;
  }, [minRestDaysPref]);
  // Separate from the gap preference above -- this is a floor on the TOTAL count of days off
  // left in the whole bid month, not a per-pickup spacing rule. Optional, default disabled.
  const [minDaysOffPref, setMinDaysOffPref] = useState("");
  const effectiveMinDaysOff = useMemo(() => {
    const n = parseInt(minDaysOffPref, 10);
    return (!isNaN(n) && n >= 1) ? n : 0;
  }, [minDaysOffPref]);
  function toggleWantedWeekday(dow) {
    setWantedWeekdays((prev) => { const n = new Set(prev); n.has(dow) ? n.delete(dow) : n.add(dow); return n; });
  }
  function toggleWantedWeekends() {
    setWantedWeekdays((prev) => {
      const n = new Set(prev);
      const bothOn = n.has(0) && n.has(6);
      if (bothOn) { n.delete(0); n.delete(6); } else { n.add(0); n.add(6); }
      return n;
    });
  }

  const [minReport, setMinReport] = useState("");
  const [maxArrive, setMaxArrive] = useState("");
  const [applyTimePref, setApplyTimePref] = useState(false);
  const [homeBase, setHomeBase] = useState("DFW");

  const [scheduleText, setScheduleText] = useState("");
  const [scheduleParsed, setScheduleParsed] = useState(null);
  const [sdoFlags, setSdoFlags] = useState(new Set());
  const [premiumFlags, setPremiumFlags] = useState(new Set());
  const [lockedFlags, setLockedFlags] = useState(new Set());
  const [sdoTripCredits, setSdoTripCredits] = useState(new Map());
  function setSdoTripCredit(key, value) {
    setSdoTripCredits((prev) => { const n = new Map(prev); if (value === "") n.delete(key); else n.set(key, value); return n; });
  }

  // ---- Sick Bank: Sick Start + manually-entered Sick/MED days, auto-dispersed ----
  // BER is deliberately not entered here -- it's read straight from the schedule paste (see
  // groupBerRuns/berGuaranteedCredit/berExtraDaySlots) and its extra days join the same
  // dispersal pool below. Sick/USIC/MED days have no such run structure -- each is its own
  // single day, entered with its scheduled credit hours; coverage is decided automatically by
  // the dispersal, not picked by the user, since the whole point is you tell the tool your
  // balance once and it works out the rest.
  const [sickBankSectionOpen, setSickBankSectionOpen] = useState(false);
  const [sickBankStart, setSickBankStart] = useState("");
  const [sickMedEntries, setSickMedEntries] = useState([]);
  const [sickDraftType, setSickDraftType] = useState("SIC");
  const [sickDraftDay, setSickDraftDay] = useState("");
  const [sickDraftHours, setSickDraftHours] = useState("");
  function addSickMedEntry() {
    const day = parseInt(sickDraftDay, 10);
    if (!day || day < 1 || day > 31) return;
    const hours = parseCreditToHours(sickDraftHours);
    if (hours == null) return;
    setSickMedEntries((prev) => [...prev, { id: `sickmed-${Date.now()}-${Math.random()}`, type: sickDraftType, day, hoursRaw: sickDraftHours }]);
    setSickDraftDay(""); setSickDraftHours("");
  }
  function removeSickMedEntry(id) {
    setSickMedEntries((prev) => prev.filter((e) => e.id !== id));
  }

  const [gridText, setGridText] = useState("");
  const [gridParsed, setGridParsed] = useState(null);
  const [manualGridRows, setManualGridRows] = useState([]);
  const [gridDateInput, setGridDateInput] = useState("");
  const [gridNetInput, setGridNetInput] = useState("");
  const [gridMinInput, setGridMinInput] = useState("");
  const [gridRowError, setGridRowError] = useState(null);

  const [openText, setOpenText] = useState("");
  const [openBase, setOpenBase] = useState(homeBase);
  const [openParsed, setOpenParsed] = useState({ trips: [], error: null });
  const [imageRows, setImageRows] = useState([]);
  const [imgPreview, setImgPreview] = useState(null);
  const [imgBase64, setImgBase64] = useState(null);
  const [imgMediaType, setImgMediaType] = useState(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [imgError, setImgError] = useState(null);

  function emptyBoardSlot(label) {
    return {
      label, expanded: false, text: "", parsed: { trips: [], error: null },
      imageRows: [], imgPreview: null, imgBase64: null, imgMediaType: null, imgLoading: false, imgError: null,
    };
  }
  const [extraBoards, setExtraBoards] = useState([
    emptyBoardSlot("Base 2"), emptyBoardSlot("Base 3"), emptyBoardSlot("Base 4"), emptyBoardSlot("Base 5"),
  ]);
  function updateExtraBoard(idx, patch) {
    setExtraBoards((prev) => prev.map((b, i) => (i === idx ? { ...b, ...(typeof patch === "function" ? patch(b) : patch) } : b)));
  }
  function toggleExtraBoardExpanded(idx) { updateExtraBoard(idx, (b) => ({ expanded: !b.expanded })); }
  function handleExtraLabelChange(idx, value) { updateExtraBoard(idx, { label: value }); }
  function handleExtraParseText(idx) { updateExtraBoard(idx, (b) => ({ parsed: parseBoard(b.text, year) })); }
  function handleExtraCSV(idx, e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => updateExtraBoard(idx, { text, parsed: parseBoard(text, year) }));
    e.target.value = "";
  }
  function readExtraImageFile(idx, file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const match = result.match(/^data:(.+);base64,(.*)$/);
      if (match) updateExtraBoard(idx, { imgMediaType: match[1], imgBase64: match[2], imgPreview: result, imgError: null });
    };
    reader.readAsDataURL(file);
  }
  function handleExtraImageSelect(idx, e) { readExtraImageFile(idx, e.target.files && e.target.files[0]); }
  function handleExtraImagePaste(idx, e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) { readExtraImageFile(idx, items[i].getAsFile()); break; }
    }
  }
  async function handleExtraExtractOpenTime(idx) {
    const board = extraBoards[idx];
    if (!board.imgBase64) return;
    updateExtraBoard(idx, { imgLoading: true, imgError: null });
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: board.imgMediaType, data: board.imgBase64 } },
              {
                type: "text",
                text: 'Extract every pairing row from this open time board screenshot into a compact JSON array only — no markdown fences, no commentary, nothing but the array. Each element: {"p":"pairing code, letters/digits, no TB badge text","d":"date like 09SEP","n":days as a number,"r":"report time HH:MM","a":"arrive time HH:MM","c":"credit like 1636","l":"layover string","tb":true if a green TB badge appears next to the pairing, else false}.',
              },
            ],
          }],
        }),
      });
      const data = await response.json();
      const text = (data.content || []).map((b) => b.text || "").join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const rows = JSON.parse(clean);
      const newRows = rows.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        pairing: r.p || "", dateTok: (r.d || "").toUpperCase(), days: String(r.n || 1),
        report: r.r || "", arrive: r.a || "", creditRaw: r.c || "", layover: r.l || "", tb: !!r.tb,
      }));
      updateExtraBoard(idx, (b) => ({ imageRows: [...b.imageRows, ...newRows], imgPreview: null, imgBase64: null, imgMediaType: null }));
    } catch (e) {
      updateExtraBoard(idx, { imgError: "Couldn't read that screenshot cleanly — try again, crop tighter, or paste the table as text instead." });
    } finally {
      updateExtraBoard(idx, { imgLoading: false });
    }
  }
  function updateExtraImageRow(idx, rowId, field, value) {
    updateExtraBoard(idx, (b) => ({ imageRows: b.imageRows.map((r) => (r.id === rowId ? { ...r, [field]: value } : r)) }));
  }
  function removeExtraImageRow(idx, rowId) {
    updateExtraBoard(idx, (b) => ({ imageRows: b.imageRows.filter((r) => r.id !== rowId) }));
  }
  function addBlankExtraImageRow(idx) {
    updateExtraBoard(idx, (b) => ({ imageRows: [...b.imageRows, { id: `${Date.now()}-manual`, pairing: "", dateTok: "", days: "1", report: "", arrive: "", creditRaw: "", layover: "", tb: false }] }));
  }

  const [tradeText, setTradeText] = useState("");
  const [tradeBase, setTradeBase] = useState(homeBase);
  const [tradeParsed, setTradeParsed] = useState({ trips: [], error: null });
  function emptyTradeBoardSlot(label, base) {
    return { label, base, expanded: false, text: "", parsed: { trips: [], error: null } };
  }
  const [extraTradeBoards, setExtraTradeBoards] = useState(
    BASES.filter((b) => b.code !== "DFW").map((b) => emptyTradeBoardSlot(b.label, b.code))
  );
  function updateExtraTradeBoard(idx, patch) {
    setExtraTradeBoards((prev) => prev.map((b, i) => (i === idx ? { ...b, ...(typeof patch === "function" ? patch(b) : patch) } : b)));
  }
  function toggleExtraTradeBoardExpanded(idx) { updateExtraTradeBoard(idx, (b) => ({ expanded: !b.expanded })); }
  function handleExtraTradeBaseChange(idx, value) { updateExtraTradeBoard(idx, { base: value }); }

  const [selected, setSelected] = useState(new Set());
  const [showAddsFor, setShowAddsFor] = useState(new Set());
  // Tracks which swap-in groups are explicitly EXPANDED (opt-in), so a group not yet interacted
  // with defaults to collapsed -- keeps the page from opening with every group's full row detail
  // sprawled out at once.
  const [expandedSwapGroups, setExpandedSwapGroups] = useState(new Set());
  function toggleSwapGroupCollapsed(key) {
    setExpandedSwapGroups((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  const [calVisible, setCalVisible] = useState({ original: true, planned: true, updated: true });
  const [theme, setTheme] = useState("light");
  function toggleTheme() { setTheme((t) => (t === "dark" ? "light" : "dark")); }

  // Purely reference features: notes and a day-by-day personal planner. Neither is read by any
  // scheduling computation in this tool — they exist only so the user can jot things down alongside
  // their schedule planning.
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesText, setNotesText] = useState("");
  const [plannerOpen, setPlannerOpen] = useState(false);
  const [dayPlans, setDayPlans] = useState({});
  function getDayActivities(dateKey) {
    const cur = dayPlans[dateKey];
    return cur && cur.length > 0 ? cur : [""];
  }
  function updateActivity(dateKey, idx, value) {
    setDayPlans((prev) => {
      const current = prev[dateKey] && prev[dateKey].length > 0 ? [...prev[dateKey]] : [""];
      current[idx] = value;
      return { ...prev, [dateKey]: current };
    });
  }
  function addActivity(dateKey) {
    setDayPlans((prev) => {
      const current = prev[dateKey] && prev[dateKey].length > 0 ? [...prev[dateKey]] : [""];
      return { ...prev, [dateKey]: [...current, ""] };
    });
  }
  function removeActivity(dateKey, idx) {
    setDayPlans((prev) => {
      const current = prev[dateKey] || [];
      const next = current.filter((_, i) => i !== idx);
      return { ...prev, [dateKey]: next };
    });
  }
  function toggleCalVisible(key) {
    setCalVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function toggleShowAdds(rowKey) {
    setShowAddsFor((prev) => { const n = new Set(prev); n.has(rowKey) ? n.delete(rowKey) : n.add(rowKey); return n; });
  }
  const [selectedSwaps, setSelectedSwaps] = useState(new Set());
  const [acceptedAdds, setAcceptedAdds] = useState(new Set());
  const [acceptedSwaps, setAcceptedSwaps] = useState(new Set());
  const [deniedAddIds, setDeniedAddIds] = useState(new Set());
  const [deniedSwapKeys, setDeniedSwapKeys] = useState(new Set());
  const [injectedTrips, setInjectedTrips] = useState([]);
  const [droppedTripsPool, setDroppedTripsPool] = useState([]);
  // Turns a dropped trip (from the schedule, or its snapshot) into a trip shaped exactly like an
  // Open Time/Trade board entry, so it flows through every existing Add/Swap/Trade computation
  // untouched. Credit is only known if the user entered it in "Your trips"; report/arrive are
  // never known for a schedule-originated trip, same limitation as everywhere else in the tool.
  function poolTripFromDropped(t) {
    const start = { year: t.startYear, month: t.startMonth, day: t.startDay };
    const days = t.days || 1;
    const dateTok = `${pad2(t.startDay)}${MONTHS[t.startMonth]}`;
    const creditHours = parseCreditToHours(sdoTripCredits.get(t.key));
    const layover = (t.destinations || []).join(" ").trim();
    const id = `dropped-${t.key}`;
    return { id, pairing: t.pairing, dateTok, days, creditHours, layover, start, report: null, arrive: null, autoTB: false, fromDrop: true, dropKey: t.key };
  }
  const [consumedTripKeys, setConsumedTripKeys] = useState(new Set());
  const [plannedOrder, setPlannedOrder] = useState([]); // [{type:'add'|'swap', id}] in priority order

  function addToPlannedOrder(type, id) {
    setPlannedOrder((prev) => (prev.some((e) => e.type === type && e.id === id) ? prev : [...prev, { type, id }]));
  }
  function removeFromPlannedOrder(type, id) {
    setPlannedOrder((prev) => prev.filter((e) => !(e.type === type && e.id === id)));
  }
  function movePlannedOrder(index, dir) {
    setPlannedOrder((prev) => {
      const arr = [...prev];
      const j = index + dir;
      if (j < 0 || j >= arr.length) return prev;
      [arr[index], arr[j]] = [arr[j], arr[index]];
      return arr;
    });
  }

  function toggleSwap(key, dependentTripIds) {
    setSelectedSwaps((prev) => {
      const n = new Set(prev);
      if (n.has(key)) {
        n.delete(key);
        if (dependentTripIds && dependentTripIds.length) {
          setSelected((prevSel) => { const s = new Set(prevSel); dependentTripIds.forEach((id) => s.delete(id)); return s; });
          dependentTripIds.forEach((id) => removeFromPlannedOrder("add", id));
        }
        removeFromPlannedOrder("swap", key);
      } else {
        n.add(key);
        addToPlannedOrder("swap", key);
      }
      return n;
    });
  }

  // Committing an accepted Add: it's no longer a day off, its credit joins the baseline,
  // and it becomes a real (already-SDO) trip on the live schedule for future drop checks.
  function acceptAddTrip(trip, flagAsSdo = true) {
    setDaysOff((prev) => { const n = new Set(prev); trip.dateKeys.forEach((k) => n.delete(k)); return n; });
    setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) + (trip.creditHours || 0)) * 100) / 100));
    const injected = {
      pairing: trip.pairing, startYear: trip.start.year, startMonth: trip.start.month, startDay: trip.start.day,
      days: trip.days, destinations: buildDestinations(trip.layover, trip.days),
      report: trip.report, arrive: trip.arrive,
    };
    setInjectedTrips((prev) => [...prev, injected]);
    if (flagAsSdo) setSdoFlags((prev) => new Set(prev).add(tripKey(injected)));
  }
  function revertAddTrip(trip) {
    setDaysOff((prev) => { const n = new Set(prev); trip.dateKeys.forEach((k) => n.add(k)); return n; });
    setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) - (trip.creditHours || 0)) * 100) / 100));
    const k = `${trip.pairing}-${trip.start.year}-${trip.start.month}-${trip.start.day}`;
    setInjectedTrips((prev) => prev.filter((it) => tripKey(it) !== k));
    setSdoFlags((prev) => { const n = new Set(prev); n.delete(k); return n; });
  }

  // Committing an accepted Swap: both dropped trips leave the live schedule, the swap-in trip
  // joins it as ordinary (non-SDO) work, and whatever days it doesn't cover become newly free.
  // swapIn is a snapshot {pairing, startYear, startMonth, startDay, days, layover, dateKeys} captured
  // at the moment of the action, so reverting later always undoes exactly what was actually applied.
  function acceptSwapPair(pair, swapIns, creditAdjustment) {
    setConsumedTripKeys((prev) => new Set(prev).add(pair.a.key).add(pair.b.key));
    setDroppedTripsPool((prev) => [...prev, poolTripFromDropped(pair.a), poolTripFromDropped(pair.b)]);
    const list = (Array.isArray(swapIns) ? swapIns : swapIns ? [swapIns] : []).filter(Boolean);
    if (list.length) {
      const allSwapInKeys = list.flatMap((si) => si.dateKeys);
      const freedKeys = [...pair.a.keys, ...pair.b.keys].filter((k) => !allSwapInKeys.includes(k));
      setDaysOff((prev) => {
        const n = new Set(prev);
        freedKeys.forEach((k) => n.add(k));
        allSwapInKeys.forEach((k) => n.delete(k));
        return n;
      });
      setInjectedTrips((prev) => [...prev, ...list.map((si) => ({
        pairing: si.pairing, startYear: si.startYear, startMonth: si.startMonth,
        startDay: si.startDay, days: si.days, destinations: buildDestinations(si.layover, si.days),
        report: si.report, arrive: si.arrive,
      }))]);
    }
    if (creditAdjustment != null) {
      setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) + creditAdjustment) * 100) / 100));
    }
  }
  function revertSwapPair(pair, swapIns, creditAdjustment) {
    setConsumedTripKeys((prev) => { const n = new Set(prev); n.delete(pair.a.key); n.delete(pair.b.key); return n; });
    setDroppedTripsPool((prev) => prev.filter((t) => t.dropKey !== pair.a.key && t.dropKey !== pair.b.key));
    const list = (Array.isArray(swapIns) ? swapIns : swapIns ? [swapIns] : []).filter(Boolean);
    if (list.length) {
      const allSwapInKeys = list.flatMap((si) => si.dateKeys);
      const freedKeys = [...pair.a.keys, ...pair.b.keys].filter((k) => !allSwapInKeys.includes(k));
      setDaysOff((prev) => { const n = new Set(prev); freedKeys.forEach((k) => n.delete(k)); return n; });
      const keysToRemove = new Set(list.map((si) => `${si.pairing}-${si.startYear}-${si.startMonth}-${si.startDay}`));
      setInjectedTrips((prev) => prev.filter((it) => !keysToRemove.has(tripKey(it))));
    }
    if (creditAdjustment != null) {
      setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) - creditAdjustment) * 100) / 100));
    }
  }
  // Swap-in credit is always known (it comes off the Open Time/Trade board). The two dropped
  // trips' credit is only known if the user entered it manually in "Your trips" — if either is
  // missing, skip the auto-adjustment entirely rather than apply a partial, misleading one.
  function computeSwapCreditAdjustment(pair, swapIns) {
    const dropCreditA = parseCreditToHours(sdoTripCredits.get(pair.a.key));
    const dropCreditB = parseCreditToHours(sdoTripCredits.get(pair.b.key));
    if (dropCreditA == null || dropCreditB == null) return null;
    const swapInCredit = (swapIns || []).reduce((s, si) => s + (si.creditHours || 0), 0);
    return swapInCredit - dropCreditA - dropCreditB;
  }
  function snapshotSwapIn(trip) {
    if (!trip) return null;
    return {
      pairing: trip.pairing, startYear: trip.start.year, startMonth: trip.start.month, startDay: trip.start.day,
      days: trip.days, layover: trip.layover, dateTok: trip.dateTok, dateKeys: tripDateKeys(trip), creditHours: trip.creditHours,
      report: trip.report, arrive: trip.arrive,
    };
  }
  function snapshotSwapIns(trips) { return (trips || []).map(snapshotSwapIn).filter(Boolean); }
  function swapInsLabel(list) {
    if (!list || !list.length) return " → no valid swap-in trip found (nothing on the board avoids your other trips)";
    return ` → swapped into ${list.map((si) => `${si.pairing} (${si.dateTok})`).join(" + ")}`;
  }
  function snapshotAddTrip(trip) {
    return {
      id: trip.id, pairing: trip.pairing, dateTok: trip.dateTok, days: trip.days, creditHours: trip.creditHours,
      layover: trip.layover, start: trip.start, dateKeys: trip.dateKeys, report: trip.report, arrive: trip.arrive,
    };
  }
  function snapshotPair(pair) {
    return {
      a: { pairing: pair.a.pairing, key: pair.a.key, keys: pair.a.keys, startYear: pair.a.startYear, startMonth: pair.a.startMonth, startDay: pair.a.startDay, days: pair.a.days, destinations: pair.a.destinations },
      b: { pairing: pair.b.pairing, key: pair.b.key, keys: pair.b.keys, startYear: pair.b.startYear, startMonth: pair.b.startMonth, startDay: pair.b.startDay, days: pair.b.days, destinations: pair.b.destinations },
    };
  }

  const [changeLog, setChangeLog] = useState([]);
  // window.confirm is unreliable inside a sandboxed artifact iframe (often silently blocked), so
  // every confirmation in this tool goes through this in-app banner instead of a browser dialog.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  function requestConfirm(message, onConfirm) { setPendingConfirm({ message, onConfirm }); }
  function resolvePendingConfirm(confirmed) {
    const pc = pendingConfirm;
    setPendingConfirm(null);
    if (confirmed && pc) pc.onConfirm();
  }
  const [showRevertedLog, setShowRevertedLog] = useState(false);
  const [acceptedSwapDetails, setAcceptedSwapDetails] = useState(new Map());

  const REVERSE_OP = { accept: "unaccept", unaccept: "accept", deny: "undeny", undeny: "deny" };

  // Every log entry stores plain, JSON-serializable data (kind/op/payload) rather than a closure,
  // so reverting works identically whether the entry was created this session or loaded from a save.
  function executeLogAction(kind, op, payload) {
    if (kind === "add") {
      const trip = payload.trip;
      if (op === "accept") doAcceptAdd(trip);
      else if (op === "unaccept") doUnacceptAdd(trip);
      else if (op === "deny") doDenyAdd(trip);
      else if (op === "undeny") doUndenyAdd(trip);
    } else if (kind === "swap") {
      const { pair, key, swapIns, creditAdjustment } = payload;
      if (op === "accept") doAcceptSwap(pair, key, swapIns, creditAdjustment);
      else if (op === "unaccept") doUnacceptSwap(pair, key, swapIns, creditAdjustment);
      else if (op === "deny") doDenySwap(pair, key, swapIns, creditAdjustment);
      else if (op === "undeny") doUndenySwap(key);
    } else if (kind === "tbadd") {
      const trip = payload.trip;
      if (op === "accept") doAcceptTbAdd(trip);
      else if (op === "unaccept") doUnacceptTbAdd(trip);
    } else if (kind === "tbdrop") {
      const trip = payload.trip;
      if (op === "accept") doAcceptTbDrop(trip);
      else if (op === "unaccept") doUnacceptTbDrop(trip);
    } else if (kind === "trade") {
      const { outgoing, incoming } = payload;
      if (op === "accept") doAcceptTrade(outgoing, incoming);
      else if (op === "unaccept") doUnacceptTrade(outgoing, incoming);
    }
  }
  function logAndExecute(kind, op, payload, description, reverseDescription) {
    executeLogAction(kind, op, payload);
    const id = `${Date.now()}-${Math.random()}`;
    setChangeLog((prev) => [...prev, { id, description, reverseDescription, reverted: false, kind, op, payload }]);
  }
  function handleRevertClick(entryId) {
    const entry = changeLog.find((e) => e.id === entryId);
    if (!entry || entry.reverted) return;
    logAndExecute(entry.kind, REVERSE_OP[entry.op], entry.payload, entry.reverseDescription, entry.description);
    setChangeLog((prev) => prev.map((e) => (e.id === entryId ? { ...e, reverted: true } : e)));
  }

  function doAcceptAdd(trip) {
    setAcceptedAdds((s) => new Set(s).add(trip.id));
    setSelected((s) => new Set(s).add(trip.id));
    acceptAddTrip(trip);
    removeFromPlannedOrder("add", trip.id);
  }
  function doUnacceptAdd(trip) {
    setAcceptedAdds((s) => { const n = new Set(s); n.delete(trip.id); return n; });
    revertAddTrip(trip);
    addToPlannedOrder("add", trip.id);
  }
  function toggleAcceptedAdd(trip) {
    const snap = snapshotAddTrip(trip);
    if (acceptedAdds.has(trip.id)) {
      logAndExecute("add", "unaccept", { trip: snap }, `Un-approved ${trip.pairing} (${trip.dateTok})`, `Approved ${trip.pairing} (${trip.dateTok})`);
    } else {
      logAndExecute("add", "accept", { trip: snap }, `Approved ${trip.pairing} (${trip.dateTok})`, `Un-approved ${trip.pairing} (${trip.dateTok})`);
    }
  }

  function doAcceptSwap(pair, key, swapIns, creditAdjustment) {
    setAcceptedSwaps((s) => new Set(s).add(key));
    setSelectedSwaps((s) => new Set(s).add(key));
    acceptSwapPair(pair, swapIns, creditAdjustment);
    removeFromPlannedOrder("swap", key);
    setAcceptedSwapDetails((prev) => {
      const n = new Map(prev);
      n.set(key, { aPairing: pair.a.pairing, bPairing: pair.b.pairing, swapIns: Array.isArray(swapIns) ? swapIns : swapIns ? [swapIns] : [], creditAdjustment });
      return n;
    });
  }
  function doUnacceptSwap(pair, key, swapIns, creditAdjustment) {
    setAcceptedSwaps((s) => { const n = new Set(s); n.delete(key); return n; });
    revertSwapPair(pair, swapIns, creditAdjustment);
    addToPlannedOrder("swap", key);
    setAcceptedSwapDetails((prev) => { const n = new Map(prev); n.delete(key); return n; });
  }
  function toggleAcceptedSwap(pair, key, swapInCandidates) {
    const label = `${pair.a.pairing} + ${pair.b.pairing}`;
    const pairSnap = snapshotPair(pair);
    if (acceptedSwaps.has(key)) {
      const stored = acceptedSwapDetails.get(key);
      const swapIns = stored ? stored.swapIns : [];
      const creditAdjustment = stored ? stored.creditAdjustment : null;
      logAndExecute("swap", "unaccept", { pair: pairSnap, key, swapIns, creditAdjustment }, `Un-approved swap ${label}${swapInsLabel(swapIns)}`, `Approved swap ${label}${swapInsLabel(swapIns)}`);
    } else {
      const candidates = Array.isArray(swapInCandidates) ? swapInCandidates : swapInCandidates ? [swapInCandidates] : [];
      const swapIns = snapshotSwapIns(candidates);
      const creditAdjustment = computeSwapCreditAdjustment(pair, swapIns);
      const adjNote = creditAdjustment != null ? ` (baseline auto-adjusted ${creditAdjustment >= 0 ? "+" : ""}${formatHours(creditAdjustment)})` : "";
      logAndExecute("swap", "accept", { pair: pairSnap, key, swapIns, creditAdjustment }, `Approved swap ${label}${swapInsLabel(swapIns)}${adjNote}`, `Un-approved swap ${label}${swapInsLabel(swapIns)}${adjNote}`);
    }
  }

  function doDenyAdd(trip) {
    setDeniedAddIds((s) => new Set(s).add(trip.id));
    setSelected((s) => { const n = new Set(s); n.delete(trip.id); return n; });
    if (acceptedAdds.has(trip.id)) { setAcceptedAdds((s) => { const n = new Set(s); n.delete(trip.id); return n; }); revertAddTrip(trip); }
    removeFromPlannedOrder("add", trip.id);
  }
  function doUndenyAdd(trip) {
    setDeniedAddIds((s) => { const n = new Set(s); n.delete(trip.id); return n; });
  }
  function toggleDeniedAdd(trip) {
    const snap = snapshotAddTrip(trip);
    if (deniedAddIds.has(trip.id)) {
      logAndExecute("add", "undeny", { trip: snap }, `Restored ${trip.pairing} (${trip.dateTok})`, `Denied ${trip.pairing} (${trip.dateTok})`);
      return;
    }
    const already = acceptedAdds.has(trip.id);
    const message = already
      ? `${trip.pairing} (${trip.dateTok}) is marked Approved — denying it will undo that (restore the day off, remove its credit). Continue?`
      : `Remove ${trip.pairing} (${trip.dateTok}) from your recommendations? You can restore it from the "Denied" list below, or from the change log, if this was a mistake.`;
    requestConfirm(message, () => {
      logAndExecute("add", "deny", { trip: snap }, `Denied ${trip.pairing} (${trip.dateTok})`, `Restored ${trip.pairing} (${trip.dateTok})`);
    });
  }

  function doDenySwap(pair, key, swapIns, creditAdjustment) {
    setDeniedSwapKeys((s) => new Set(s).add(key));
    setSelectedSwaps((s) => { const n = new Set(s); n.delete(key); return n; });
    if (acceptedSwaps.has(key)) {
      setAcceptedSwaps((s) => { const n = new Set(s); n.delete(key); return n; });
      revertSwapPair(pair, swapIns, creditAdjustment);
      setAcceptedSwapDetails((prev) => { const n = new Map(prev); n.delete(key); return n; });
    }
    removeFromPlannedOrder("swap", key);
  }
  function doUndenySwap(key) {
    setDeniedSwapKeys((s) => { const n = new Set(s); n.delete(key); return n; });
  }
  function toggleDeniedSwap(pair, key, swapInCandidates) {
    const label = `${pair.a.pairing} + ${pair.b.pairing}`;
    const pairSnap = snapshotPair(pair);
    if (deniedSwapKeys.has(key)) {
      logAndExecute("swap", "undeny", { pair: pairSnap, key, swapIns: [], creditAdjustment: null }, `Restored swap ${label}`, `Denied swap ${label}`);
      return;
    }
    const already = acceptedSwaps.has(key);
    const message = already
      ? `The ${label} swap is marked Approved — denying it will undo that (restore the dropped trips, remove the swap-in). Continue?`
      : `Remove the ${label} swap from your recommendations? You can restore it from the "Denied" list below, or from the change log, if this was a mistake.`;
    requestConfirm(message, () => {
      const candidates = Array.isArray(swapInCandidates) ? swapInCandidates : swapInCandidates ? [swapInCandidates] : [];
      const stored = already ? acceptedSwapDetails.get(key) : null;
      const swapIns = already ? (stored?.swapIns || []) : snapshotSwapIns(candidates);
      const creditAdjustment = already ? (stored?.creditAdjustment ?? null) : null;
      const swapInNote = swapIns.length ? ` (swap-in was ${swapIns.map((si) => `${si.pairing}, ${si.dateTok}`).join(" + ")})` : "";
      logAndExecute("swap", "deny", { pair: pairSnap, key, swapIns, creditAdjustment }, `Denied swap ${label}${swapInNote}`, `Restored swap ${label}${swapInNote}`);
    });
  }

  const [tbAddRequested, setTbAddRequested] = useState(new Set());
  const [tradeOutgoingKey, setTradeOutgoingKey] = useState("");
  const [tradeIncomingMode, setTradeIncomingMode] = useState("board");
  const [tradeIncomingBoardId, setTradeIncomingBoardId] = useState("");
  const [tradeIncomingOpenPotId, setTradeIncomingOpenPotId] = useState("");
  const [tradeManualPairing, setTradeManualPairing] = useState("");
  const [tradeManualDateTok, setTradeManualDateTok] = useState("");
  const [tradeManualDays, setTradeManualDays] = useState("1");
  const [tradeManualCreditRaw, setTradeManualCreditRaw] = useState("");
  const [tradeManualLayover, setTradeManualLayover] = useState("");
  const [tradeFormError, setTradeFormError] = useState(null);
  const [tradeSectionOpen, setTradeSectionOpen] = useState(false);
  const [openPotViewerOpen, setOpenPotViewerOpen] = useState(false);
  const [addsReadySectionOpen, setAddsReadySectionOpen] = useState(true);
  const [addsNearMissSectionOpen, setAddsNearMissSectionOpen] = useState(false);
  const [swapsSectionOpen, setSwapsSectionOpen] = useState(true);
  const [tbPostSectionOpen, setTbPostSectionOpen] = useState(true);
  const [tbAddSectionOpen, setTbAddSectionOpen] = useState(true);
  const [allowSdoTrade, setAllowSdoTrade] = useState(false);
  const [tbAddAccepted, setTbAddAccepted] = useState(new Set());
  const [tbDropRequested, setTbDropRequested] = useState(new Set());
  const [tbDropAccepted, setTbDropAccepted] = useState(new Set());

  function toggleTbAddRequested(trip) {
    setTbAddRequested((s) => { const n = new Set(s); n.has(trip.id) ? n.delete(trip.id) : n.add(trip.id); return n; });
  }
  function doAcceptTbAdd(trip) {
    setTbAddAccepted((s) => new Set(s).add(trip.id));
    setTbAddRequested((s) => new Set(s).add(trip.id));
    acceptAddTrip(trip, false);
  }
  function doUnacceptTbAdd(trip) {
    setTbAddAccepted((s) => { const n = new Set(s); n.delete(trip.id); return n; });
    revertAddTrip(trip);
  }
  function toggleTbAddAccepted(trip) {
    const snap = snapshotAddTrip(trip);
    if (tbAddAccepted.has(trip.id)) {
      logAndExecute("tbadd", "unaccept", { trip: snap }, `Un-approved Trade Board add ${trip.pairing} (${trip.dateTok})`, `Approved Trade Board add ${trip.pairing} (${trip.dateTok})`);
    } else {
      logAndExecute("tbadd", "accept", { trip: snap }, `Approved Trade Board add ${trip.pairing} (${trip.dateTok})`, `Un-approved Trade Board add ${trip.pairing} (${trip.dateTok})`);
    }
  }

  function toggleTbDropRequested(trip) {
    setTbDropRequested((s) => { const n = new Set(s); n.has(trip.key) ? n.delete(trip.key) : n.add(trip.key); return n; });
  }
  function acceptTbDrop(trip) {
    setConsumedTripKeys((prev) => new Set(prev).add(trip.key));
    setDaysOff((prev) => { const n = new Set(prev); trip.keys.forEach((k) => n.add(k)); return n; });
  }
  function revertTbDrop(trip) {
    setConsumedTripKeys((prev) => { const n = new Set(prev); n.delete(trip.key); return n; });
    setDaysOff((prev) => { const n = new Set(prev); trip.keys.forEach((k) => n.delete(k)); return n; });
  }
  function doAcceptTbDrop(trip) {
    setTbDropAccepted((s) => new Set(s).add(trip.key));
    setTbDropRequested((s) => new Set(s).add(trip.key));
    acceptTbDrop(trip);
  }
  function doUnacceptTbDrop(trip) {
    setTbDropAccepted((s) => { const n = new Set(s); n.delete(trip.key); return n; });
    revertTbDrop(trip);
  }
  function toggleTbDropAccepted(trip) {
    const snap = { key: trip.key, keys: trip.keys, pairing: trip.pairing, startYear: trip.startYear, startMonth: trip.startMonth, startDay: trip.startDay, days: trip.days, destinations: trip.destinations };
    if (tbDropAccepted.has(trip.key)) {
      logAndExecute("tbdrop", "unaccept", { trip: snap }, `Un-approved Trade Board pickup of ${trip.pairing}`, `Approved Trade Board pickup of ${trip.pairing}`);
      return;
    }
    requestConfirm(`Mark ${trip.pairing} as picked up off the Trade Board by someone else? This drops it from your live schedule and frees its days for new recommendations.`, () => {
      logAndExecute("tbdrop", "accept", { trip: snap }, `Approved Trade Board pickup of ${trip.pairing}`, `Un-approved Trade Board pickup of ${trip.pairing}`);
    });
  }

  // A genuine person-to-person Trade: give one of your trips away, receive a specific trip back.
  // Neither leg needs a Reserve Grid check — the other crewmember takes over your old days exactly
  // as you take over theirs, so coverage never actually lapses on either side. Never earns SDO.
  const [tradeDetails, setTradeDetails] = useState(new Map());
  function doAcceptTrade(outgoing, incoming) {
    setConsumedTripKeys((prev) => new Set(prev).add(outgoing.key));
    setDaysOff((prev) => {
      const n = new Set(prev);
      outgoing.keys.forEach((k) => { if (!incoming.dateKeys.includes(k)) n.add(k); });
      incoming.dateKeys.forEach((k) => n.delete(k));
      return n;
    });
    setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) + (incoming.creditHours || 0)) * 100) / 100));
    setInjectedTrips((prev) => [...prev, {
      pairing: incoming.pairing, startYear: incoming.start.year, startMonth: incoming.start.month, startDay: incoming.start.day,
      days: incoming.days, destinations: buildDestinations(incoming.layover, incoming.days), report: incoming.report, arrive: incoming.arrive,
    }]);
    setTradeDetails((prev) => { const n = new Map(prev); n.set(outgoing.key, { outgoingPairing: outgoing.pairing, outgoingKeys: outgoing.keys, incoming }); return n; });
  }
  function doUnacceptTrade(outgoing, incoming) {
    setConsumedTripKeys((prev) => { const n = new Set(prev); n.delete(outgoing.key); return n; });
    setDaysOff((prev) => {
      const n = new Set(prev);
      outgoing.keys.forEach((k) => { if (!incoming.dateKeys.includes(k)) n.delete(k); });
      incoming.dateKeys.forEach((k) => n.add(k));
      return n;
    });
    setBaselineCredit((prev) => String(Math.round(((parseFloat(prev) || 0) - (incoming.creditHours || 0)) * 100) / 100));
    const k = `${incoming.pairing}-${incoming.start.year}-${incoming.start.month}-${incoming.start.day}`;
    setInjectedTrips((prev) => prev.filter((it) => tripKey(it) !== k));
    setTradeDetails((prev) => { const n = new Map(prev); n.delete(outgoing.key); return n; });
  }
  function recordTrade(outgoing, incoming) {
    const label = `Traded ${outgoing.pairing} for ${incoming.pairing} (${incoming.dateTok})`;
    const outSnap = { key: outgoing.key, keys: outgoing.keys, pairing: outgoing.pairing };
    logAndExecute("trade", "accept", { outgoing: outSnap, incoming }, label, `Un-${label.charAt(0).toLowerCase()}${label.slice(1)}`);
  }
  function undoTrade(outgoingKey) {
    const d = tradeDetails.get(outgoingKey);
    if (!d) return;
    const outSnap = { key: outgoingKey, keys: d.outgoingKeys, pairing: d.outgoingPairing };
    logAndExecute("trade", "unaccept", { outgoing: outSnap, incoming: d.incoming }, `Un-traded ${d.outgoingPairing} for ${d.incoming.pairing}`, `Traded ${d.outgoingPairing} for ${d.incoming.pairing} (${d.incoming.dateTok})`);
  }

  function performTrade() {
    setTradeFormError(null);
    const outgoing = droppableTrips.find((t) => t.key === tradeOutgoingKey);
    if (!outgoing) { setTradeFormError("Pick one of your own trips to give away first."); return; }

    let incoming;
    if (tradeIncomingMode === "openpot") {
      const potTrip = enrichedOpen.find((t) => t.id === tradeIncomingOpenPotId);
      if (!potTrip) { setTradeFormError("Pick a trip from the Opentime pot first."); return; }
      if (!potTrip.start) { setTradeFormError(`Couldn't read a valid date from ${potTrip.pairing} — check the Opentime pot data.`); return; }
      incoming = {
        pairing: potTrip.pairing, dateTok: potTrip.dateTok, days: potTrip.days, creditHours: potTrip.creditHours,
        layover: potTrip.layover, start: potTrip.start, dateKeys: tripDateKeys(potTrip), report: potTrip.report, arrive: potTrip.arrive,
      };
    } else if (tradeIncomingMode === "board") {
      const boardTrip = allTradeTrips.find((t) => t.id === tradeIncomingBoardId);
      if (!boardTrip) { setTradeFormError("Pick a trip from the loaded Trade Board first."); return; }
      if (!boardTrip.start) { setTradeFormError(`Couldn't read a valid date from ${boardTrip.pairing} — check the Trade Board data.`); return; }
      incoming = {
        pairing: boardTrip.pairing, dateTok: boardTrip.dateTok, days: boardTrip.days, creditHours: boardTrip.creditHours,
        layover: boardTrip.layover, start: boardTrip.start, dateKeys: tripDateKeys(boardTrip), report: boardTrip.report, arrive: boardTrip.arrive,
      };
    } else {
      const pairing = tradeManualPairing.trim().toUpperCase();
      if (!pairing) { setTradeFormError("Enter the incoming trip's pairing number."); return; }
      const start = parseDateToken(tradeManualDateTok, year);
      if (!start) { setTradeFormError('Enter the incoming trip\'s date like "09SEP".'); return; }
      const days = parseInt(tradeManualDays, 10) || 1;
      const creditHours = parseCreditToHours(tradeManualCreditRaw);
      if (creditHours == null) { setTradeFormError('Enter the incoming trip\'s credit like 1636 (16h36m).'); return; }
      const dateTok = tradeManualDateTok.trim().toUpperCase();
      incoming = {
        pairing, dateTok, days, creditHours, layover: tradeManualLayover.trim(), start,
        dateKeys: tripDateKeys({ start, days }), report: null, arrive: null,
      };
    }

    const message = `Trade ${outgoing.pairing} away for ${incoming.pairing} (${incoming.dateTok})? This updates your schedule immediately — days off, credit, and every recommendation below.`;
    requestConfirm(message, () => {
      recordTrade(outgoing, incoming);
      setTradeOutgoingKey(""); setTradeIncomingBoardId(""); setTradeIncomingOpenPotId("");
      setTradeManualPairing(""); setTradeManualDateTok(""); setTradeManualDays("1"); setTradeManualCreditRaw(""); setTradeManualLayover("");
    });
  }

  const [saveStatus, setSaveStatus] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);

  function serializePlannerState() {
    return {
      savedAt: Date.now(),
      rate, year, month, baselineCredit,
      daysOff: [...daysOff],
      wantedText, wantedWeekdays: [...wantedWeekdays], minReport, maxArrive, applyTimePref, homeBase,
      scheduleText,
      scheduleParsed: scheduleParsed ? { trips: scheduleParsed.trips, daysOff: [...scheduleParsed.daysOff], vacationDays: [...scheduleParsed.vacationDays], protectedDayCodes: [...(scheduleParsed.protectedDayCodes || new Map()).entries()], summary: scheduleParsed.summary } : null,
      sdoFlags: [...sdoFlags], premiumFlags: [...premiumFlags], lockedFlags: [...lockedFlags],
      gridText, manualGridRows, gridParsed: gridParsed ? { ...gridParsed, grid: [...gridParsed.grid.entries()] } : null,
      openText, openBase, openParsed, imageRows,
      extraBoards: extraBoards.map((b) => ({ ...b, imgPreview: null, imgBase64: null, imgError: null, imgLoading: false })),
      tradeText, tradeBase, tradeParsed, extraTradeBoards,
      selected: [...selected], selectedSwaps: [...selectedSwaps],
      acceptedAdds: [...acceptedAdds], acceptedSwaps: [...acceptedSwaps],
      deniedAddIds: [...deniedAddIds], deniedSwapKeys: [...deniedSwapKeys],
      injectedTrips, consumedTripKeys: [...consumedTripKeys], droppedTripsPool,
      plannedOrder,
      acceptedSwapDetails: [...acceptedSwapDetails.entries()],
      changeLog,
      tbAddRequested: [...tbAddRequested], tbAddAccepted: [...tbAddAccepted],
      tbDropRequested: [...tbDropRequested], tbDropAccepted: [...tbDropAccepted],
      tradeDetails: [...tradeDetails.entries()],
      sdoTripCredits: [...sdoTripCredits.entries()],
      sickBankSectionOpen, sickBankStart, sickMedEntries,
      notesOpen, notesText, plannerOpen, dayPlans, maxConsecutiveDaysPref, minRestDaysPref, minDaysOffPref,
      tradeSectionOpen, allowSdoTrade, openPotViewerOpen,
      addsReadySectionOpen, addsNearMissSectionOpen, swapsSectionOpen, tbPostSectionOpen, tbAddSectionOpen,
      calVisible, theme,
    };
  }

  async function savePlannerState(silent) {
    if (!session?.user?.id) { if (silent !== true) setSaveStatus("Saving isn't available right now."); return; }
    if (silent !== true) setSaveStatus("Saving…");
    try {
      const { error } = await supabase.from("planner_state").upsert({
        user_id: session.user.id,
        data: serializePlannerState(),
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
      setSaveStatus(`Saved ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      if (silent !== true) setSaveStatus("Save failed — try again.");
    }
    saveMonthlyStats(); // best-effort analytics snapshot -- never affects the status above
  }

  // Snapshot (not a running total) of this bid month's confirmed SDO bonus
  // and credit hours, upserted every save -- lets the account owner see how
  // much the tool is actually getting each user, without exposing anyone's
  // full schedule data (see supabase/admin_stats_schema.sql for the RLS
  // that only the owner's account can read across users).
  async function saveMonthlyStats() {
    if (!session?.user?.id) return;
    try {
      await supabase.from("monthly_stats").upsert({
        user_id: session.user.id,
        email: session.user.email,
        bid_year: year,
        bid_month: month + 1,
        hourly_rate: hourlyRate,
        confirmed_bonus_hours: confirmedBonusHours,
        confirmed_bonus_dollars: confirmedBonusHours * hourlyRate,
        total_confirmed_credit_hours: totalConfirmedCreditHours,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      // Silent on purpose -- this is a secondary analytics write, never worth
      // alarming the user (or blocking their actual save) over.
    }
  }

  async function loadPlannerState(announce) {
    if (!session?.user?.id) return;
    try {
      const { data: row, error } = await supabase
        .from("planner_state")
        .select("data")
        .eq("user_id", session.user.id)
        .maybeSingle();
      if (error) throw error;
      if (!row || !row.data || Object.keys(row.data).length === 0) { if (announce) setSaveStatus("No saved data found."); return; }
      const d = row.data;
      if (d.rate != null) setRate(d.rate);
      if (d.year != null) setYear(d.year);
      if (d.month != null) setMonth(d.month);
      if (d.baselineCredit != null) setBaselineCredit(d.baselineCredit);
      if (d.daysOff) setDaysOff(new Set(d.daysOff));
      if (d.wantedText != null) setWantedText(d.wantedText);
      if (d.wantedWeekdays) setWantedWeekdays(new Set(d.wantedWeekdays));
      if (d.minReport != null) setMinReport(d.minReport);
      if (d.maxArrive != null) setMaxArrive(d.maxArrive);
      if (d.applyTimePref != null) setApplyTimePref(d.applyTimePref);
      if (d.homeBase != null) setHomeBase(d.homeBase);
      if (d.scheduleText != null) setScheduleText(d.scheduleText);
      if (d.scheduleParsed) setScheduleParsed({ trips: d.scheduleParsed.trips, daysOff: new Set(d.scheduleParsed.daysOff), vacationDays: new Set(d.scheduleParsed.vacationDays || []), protectedDayCodes: new Map(d.scheduleParsed.protectedDayCodes || []), summary: d.scheduleParsed.summary });
      if (d.sdoFlags) setSdoFlags(new Set(d.sdoFlags));
      if (d.premiumFlags) setPremiumFlags(new Set(d.premiumFlags));
      if (d.lockedFlags) setLockedFlags(new Set(d.lockedFlags));
      if (d.gridText != null) setGridText(d.gridText);
      if (d.gridParsed) setGridParsed({ ...d.gridParsed, grid: new Map(d.gridParsed.grid) });
      if (d.manualGridRows) setManualGridRows(d.manualGridRows);
      if (d.openText != null) setOpenText(d.openText);
      if (d.openBase != null) setOpenBase(d.openBase);
      if (d.openParsed) setOpenParsed(d.openParsed);
      if (d.imageRows) setImageRows(d.imageRows);
      if (d.extraBoards) setExtraBoards(d.extraBoards);
      if (d.tradeText != null) setTradeText(d.tradeText);
      if (d.tradeBase != null) setTradeBase(d.tradeBase);
      if (d.tradeParsed) setTradeParsed(d.tradeParsed);
      if (d.extraTradeBoards) setExtraTradeBoards(d.extraTradeBoards);
      if (d.selected) setSelected(new Set(d.selected));
      if (d.selectedSwaps) setSelectedSwaps(new Set(d.selectedSwaps));
      if (d.acceptedAdds) setAcceptedAdds(new Set(d.acceptedAdds));
      if (d.acceptedSwaps) setAcceptedSwaps(new Set(d.acceptedSwaps));
      if (d.deniedAddIds) setDeniedAddIds(new Set(d.deniedAddIds));
      if (d.deniedSwapKeys) setDeniedSwapKeys(new Set(d.deniedSwapKeys));
      if (d.injectedTrips) setInjectedTrips(d.injectedTrips);
      if (d.droppedTripsPool) setDroppedTripsPool(d.droppedTripsPool);
      if (d.consumedTripKeys) setConsumedTripKeys(new Set(d.consumedTripKeys));
      if (d.plannedOrder) setPlannedOrder(d.plannedOrder);
      if (d.acceptedSwapDetails) setAcceptedSwapDetails(new Map(d.acceptedSwapDetails));
      if (d.changeLog) setChangeLog(d.changeLog);
      if (d.tbAddRequested) setTbAddRequested(new Set(d.tbAddRequested));
      if (d.tbAddAccepted) setTbAddAccepted(new Set(d.tbAddAccepted));
      if (d.tbDropRequested) setTbDropRequested(new Set(d.tbDropRequested));
      if (d.tbDropAccepted) setTbDropAccepted(new Set(d.tbDropAccepted));
      if (d.tradeDetails) setTradeDetails(new Map(d.tradeDetails));
      if (d.sdoTripCredits) setSdoTripCredits(new Map(d.sdoTripCredits));
      if (d.sickBankSectionOpen != null) setSickBankSectionOpen(d.sickBankSectionOpen);
      if (d.sickBankStart != null) setSickBankStart(d.sickBankStart);
      if (d.sickMedEntries) setSickMedEntries(d.sickMedEntries);
      if (d.notesOpen != null) setNotesOpen(d.notesOpen);
      if (d.notesText != null) setNotesText(d.notesText);
      if (d.plannerOpen != null) setPlannerOpen(d.plannerOpen);
      if (d.dayPlans) setDayPlans(d.dayPlans);
      if (d.maxConsecutiveDaysPref != null) setMaxConsecutiveDaysPref(d.maxConsecutiveDaysPref);
      if (d.minRestDaysPref != null) setMinRestDaysPref(d.minRestDaysPref);
      if (d.minDaysOffPref != null) setMinDaysOffPref(d.minDaysOffPref);
      if (d.tradeSectionOpen != null) setTradeSectionOpen(d.tradeSectionOpen);
      if (d.openPotViewerOpen != null) setOpenPotViewerOpen(d.openPotViewerOpen);
      if (d.addsReadySectionOpen != null) setAddsReadySectionOpen(d.addsReadySectionOpen);
      if (d.addsNearMissSectionOpen != null) setAddsNearMissSectionOpen(d.addsNearMissSectionOpen);
      if (d.swapsSectionOpen != null) setSwapsSectionOpen(d.swapsSectionOpen);
      if (d.tbPostSectionOpen != null) setTbPostSectionOpen(d.tbPostSectionOpen);
      if (d.tbAddSectionOpen != null) setTbAddSectionOpen(d.tbAddSectionOpen);
      if (d.allowSdoTrade != null) setAllowSdoTrade(d.allowSdoTrade);
      if (d.calVisible) setCalVisible(d.calVisible);
      if (d.theme) setTheme(d.theme);
      setSaveStatus(`Loaded save from ${new Date(d.savedAt || Date.now()).toLocaleString()}`);
    } catch (e) {
      if (announce) setSaveStatus("Couldn't load saved data.");
    }
  }

  async function clearSavedState() {
    if (!session?.user?.id) return;
    requestConfirm("Delete your saved progress? This can't be undone.", async () => {
      try {
        const { error } = await supabase.from("planner_state").upsert({
          user_id: session.user.id,
          data: {},
          updated_at: new Date().toISOString(),
        });
        if (error) throw error;
        setSaveStatus("Saved data cleared.");
      } catch (e) {
        setSaveStatus("Couldn't clear saved data.");
      }
    });
  }

  useEffect(() => {
    if (!loadedOnce) { setLoadedOnce(true); loadPlannerState(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep a ref to the latest savePlannerState closure so the interval/unload
  // handlers below (set up once) always save the current state, not whatever
  // it was when they were first attached.
  const savePlannerStateRef = useRef(savePlannerState);
  useEffect(() => { savePlannerStateRef.current = savePlannerState; });

  useEffect(() => {
    if (!loadedOnce) return;
    const interval = setInterval(() => { savePlannerStateRef.current(true); }, 20000);
    function saveOnHide() {
      if (document.visibilityState === "hidden") savePlannerStateRef.current(true);
    }
    document.addEventListener("visibilitychange", saveOnHide);
    window.addEventListener("pagehide", saveOnHide);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", saveOnHide);
      window.removeEventListener("pagehide", saveOnHide);
    };
  }, [loadedOnce]);

  const nextMonth = (month + 1) % 12;
  const nextMonthYear = month === 11 ? year + 1 : year;
  const hourlyRate = parseFloat(rate) || 0;
  const wantedOff = useMemo(() => {
    const fromText = parseWantedDays(wantedText, year, month, nextMonth, nextMonthYear);
    if (wantedWeekdays.size === 0) return fromText;
    const combined = new Set(fromText);
    [[year, month], [nextMonthYear, nextMonth]].forEach(([y, m]) => {
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        if (wantedWeekdays.has(new Date(y, m, day).getDay())) combined.add(dateKey(y, m, day));
      }
    });
    return combined;
  }, [wantedText, wantedWeekdays, year, month, nextMonth, nextMonthYear]);

  function toggleDayOff(key) {
    setDaysOff((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  // Never marks a day "off" that's actually occupied by a live trip -- daysOff and the real
  // schedule (occupiedDateKeys) would otherwise silently contradict each other, and every
  // downstream eligibility check trusts daysOff alone. A day genuinely needs to be freed (drop
  // the trip on it, via a Swap) before it can be marked off; this only ever fills in a day that
  // simply wasn't marked off for some other reason.
  function addDaysOff(keys) {
    setDaysOff((prev) => {
      const n = new Set(prev);
      keys.forEach((k) => { if (!occupiedDateKeys.has(k)) n.add(k); });
      return n;
    });
  }
  function tripKey(t) { return `${t.pairing}-${t.startYear}-${t.startMonth}-${t.startDay}`; }
  function toggleFlag(setFn, key) {
    setFn((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  function applyScheduleText(text) {
    const result = parseSchedule(text, year, month);
    setScheduleParsed(result);
    // Re-parsing (e.g. pasting a freshly-exported schedule that now shows a trip picked up for
    // real in FLICA, outside this tool, on a day that used to be off) must reconcile daysOff
    // against the FRESH parse's own trips, not just union the new parse's days-off into whatever
    // was already there -- addDaysOff only ever adds, so a day this fresh parse now shows as
    // occupied would otherwise stay stranded in daysOff forever, contradicting the schedule that
    // was just pasted and making every Add overlapping it look falsely eligible. Any day the
    // fresh parse's own trips actually occupy is cleared here even if something earlier (a stale
    // parse, a prior approval) had marked it off.
    const freshlyOccupied = new Set();
    result.trips.forEach((t) => scheduleTripDateKeys(t).forEach((k) => freshlyOccupied.add(k)));
    setDaysOff((prev) => {
      const n = new Set(prev);
      result.daysOff.forEach((k) => n.add(k));
      freshlyOccupied.forEach((k) => n.delete(k));
      return n;
    });
    if (result.summary.credit != null) setBaselineCredit(String(result.summary.credit));
    // A schedule trip whose pairing+date exactly matches an Open Time Add you'd already marked
    // "Planned" is one you clearly meant to pick up for SDO -- if it's now showing up for real
    // (picked up in FLICA, then this updated schedule re-pasted), flag it automatically instead
    // of leaving it to be found and re-checked by hand in "Your trips". This also carries
    // forward any flag whose trip is still actually live (still in this new parse, or already
    // committed via injectedTrips) -- re-parsing the schedule shouldn't silently forget an SDO
    // trip that was already flagged or accepted before this re-paste.
    const plannedAddIdentities = new Set(
      enrichedOpen
        .filter((t) => selected.has(t.id) && t.start)
        .map((t) => tripKey({ pairing: t.pairing, startYear: t.start.year, startMonth: t.start.month, startDay: t.start.day }))
    );
    setSdoFlags((prev) => {
      const next = new Set([...prev].filter((key) =>
        injectedTrips.some((it) => tripKey(it) === key) || result.trips.some((t) => tripKey(t) === key)
      ));
      result.trips.forEach((t) => { if (plannedAddIdentities.has(tripKey(t))) next.add(tripKey(t)); });
      return next;
    });
    setPremiumFlags(new Set());
  }
  function handleParseSchedule() { applyScheduleText(scheduleText); }
  function handleParseGrid() { setGridParsed(parseReserveGrid(gridText, year)); }
  // Only Trade Board's CSV-export format ever parses its own per-trip base (see
  // parseTradeBoardPairingCell) -- everywhere else, a trip keeps whatever base it already
  // carries and otherwise takes the base selected for the paste box it came from, so every
  // trip ends up base-tagged for passesTimePref's conversion, not just CSV exports.
  function tagBase(parsed, base) {
    return { ...parsed, trips: parsed.trips.map((t) => ({ ...t, base: t.base || base })) };
  }
  function handleParseOpen() { setOpenParsed(tagBase(parseBoard(openText, year), openBase)); setSelected(new Set()); }

  function readTextFile(file, onText) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      onText(text);
    };
    reader.readAsText(file);
  }
  function handleScheduleCSV(e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => { setScheduleText(text); applyScheduleText(text); });
    e.target.value = "";
  }
  function handleGridCSV(e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => { setGridText(text); setGridParsed(parseReserveGrid(text, year)); });
    e.target.value = "";
  }
  function handleOpenCSV(e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => { setOpenText(text); setOpenParsed(tagBase(parseBoard(text, year), openBase)); setSelected(new Set()); });
    e.target.value = "";
  }
  function looksLikeFlicaTradeExport(text) {
    return /tripbase/i.test(text.slice(0, 1000)) || /pairing details/i.test(text.slice(0, 1000));
  }
  function looksLikeFlicaTradeRawPaste(text) {
    return /add to favorites/i.test(text.slice(0, 2000));
  }
  function parseTradeInput(text) {
    if (looksLikeFlicaTradeRawPaste(text)) return parseTradeBoardRawPaste(text, year);
    if (looksLikeFlicaTradeExport(text)) return parseTradeBoardExport(text, year);
    return parseBoard(text, year);
  }
  function handleTradeCSV(e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => {
      if (looksLikeFlicaTradeRawPaste(text) || looksLikeFlicaTradeExport(text)) {
        setTradeParsed(tagBase(parseTradeInput(text), tradeBase));
        setTradeText("");
      } else {
        setTradeText(text);
        setTradeParsed(tagBase(parseBoard(text, year), tradeBase));
      }
    });
    e.target.value = "";
  }
  function handleExtraTradeParseText(idx) {
    updateExtraTradeBoard(idx, (b) => ({ parsed: tagBase(parseTradeInput(b.text), b.base) }));
  }
  function handleExtraTradeCSV(idx, e) {
    const file = e.target.files && e.target.files[0];
    readTextFile(file, (text) => updateExtraTradeBoard(idx, (b) => ({ text, parsed: tagBase(parseTradeInput(text), b.base) })));
    e.target.value = "";
  }

  function readImageFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const match = result.match(/^data:(.+);base64,(.*)$/);
      if (match) { setImgMediaType(match[1]); setImgBase64(match[2]); setImgPreview(result); setImgError(null); }
    };
    reader.readAsDataURL(file);
  }
  function handleImageSelect(e) {
    const file = e.target.files && e.target.files[0];
    readImageFile(file);
  }
  function handleImagePaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) { readImageFile(items[i].getAsFile()); break; }
    }
  }

  async function handleExtractOpenTime() {
    if (!imgBase64) return;
    setImgLoading(true); setImgError(null);
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: imgMediaType, data: imgBase64 } },
              {
                type: "text",
                text: 'Extract every pairing row from this open time board screenshot into a compact JSON array only — no markdown fences, no commentary, nothing but the array. Each element: {"p":"pairing code, letters/digits, no TB badge text","d":"date like 09SEP","n":days as a number,"r":"report time HH:MM","a":"arrive time HH:MM","c":"credit like 1636","l":"layover string","tb":true if a green TB badge appears next to the pairing, else false}.',
              },
            ],
          }],
        }),
      });
      const data = await response.json();
      const text = (data.content || []).map((b) => b.text || "").join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const rows = JSON.parse(clean);
      const newRows = rows.map((r, i) => ({
        id: `${Date.now()}-${i}`,
        pairing: r.p || "", dateTok: (r.d || "").toUpperCase(), days: String(r.n || 1),
        report: r.r || "", arrive: r.a || "", creditRaw: r.c || "", layover: r.l || "", tb: !!r.tb,
      }));
      setImageRows((prev) => [...prev, ...newRows]);
      setImgPreview(null); setImgBase64(null); setImgMediaType(null);
    } catch (e) {
      setImgError("Couldn't read that screenshot cleanly — try again, crop tighter, or paste the table as text instead.");
    } finally {
      setImgLoading(false);
    }
  }

  function updateImageRow(id, field, value) {
    setImageRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }
  function removeImageRow(id) { setImageRows((prev) => prev.filter((r) => r.id !== id)); }
  function addBlankImageRow() {
    setImageRows((prev) => [...prev, { id: `${Date.now()}-manual`, pairing: "", dateTok: "", days: "1", report: "", arrive: "", creditRaw: "", layover: "", tb: false }]);
  }
  function handleParseTrade() { setTradeParsed(tagBase(parseTradeInput(tradeText), tradeBase)); }

  function handleAddGridRow() {
    const parsed = parseDateToken(gridDateInput, year);
    const net = parseFloat(gridNetInput);
    const min = parseFloat(gridMinInput);
    if (!parsed) { setGridRowError('Date should look like "09SEP".'); return; }
    if (isNaN(net) || isNaN(min)) { setGridRowError("Net Reserves and Min Required both need a number."); return; }
    setGridRowError(null);
    setManualGridRows((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, dateTok: gridDateInput.trim().toUpperCase(), net, min }]);
    setGridDateInput(""); setGridNetInput(""); setGridMinInput("");
  }
  function removeGridRow(id) { setManualGridRows((prev) => prev.filter((r) => r.id !== id)); }

  const combinedGrid = useMemo(() => {
    const map = new Map(gridParsed ? gridParsed.grid : []);
    manualGridRows.forEach((r) => {
      const parsed = parseDateToken(r.dateTok, year);
      if (!parsed) return;
      map.set(dateKey(parsed.year, parsed.month, parsed.day), r.net > r.min ? "green" : r.net === r.min ? "black" : "red");
    });
    return map;
  }, [gridParsed, manualGridRows, year]);

  const hasGridData = combinedGrid.size > 0;
  const gridStatus = (key) => combinedGrid.get(key) || "unknown";
  // The Reserve Grid only ever covers the one bid month currently loaded -- a trip that starts
  // or ends in a different month is still fine to drop/swap as long as whatever days actually
  // fall in THIS month are green. A day outside the loaded month isn't a blocker just because
  // there's no (and never will be any) grid data for it -- it's simply out of scope, not unknown.
  function gridOkForMonth(key) {
    const monthPrefix = `${year}-${pad2(month + 1)}`;
    return !key.startsWith(monthPrefix) || gridStatus(key) === "green";
  }

  const liveTrips = useMemo(() => {
    if (!scheduleParsed) return [];
    return [
      ...scheduleParsed.trips.filter((t) => !consumedTripKeys.has(tripKey(t))),
      ...injectedTrips,
    ];
  }, [scheduleParsed, consumedTripKeys, injectedTrips]);

  // Every day currently committed to ANY live trip — used both to keep a swap-in from
  // colliding with another trip, and to enforce the no-more-than-6-days-in-a-row rule.
  const occupiedDateKeys = useMemo(() => {
    const s = new Set();
    liveTrips.forEach((t) => scheduleTripDateKeys(t).forEach((k) => s.add(k)));
    return s;
  }, [liveTrips]);

  // Manually-entered Sick/MED days (Sick Bank tracker below) aren't part of the schedule paste,
  // but are just as much a protected day off as a VAC/PED line would be -- can't have work put
  // over them either. BER never needs this: it's read straight from the schedule paste, so
  // parseSchedule already adds it to vacationDays/protectedDayCodes the same way VAC/PED are.
  const sickMedProtectedDateKeys = useMemo(() => {
    const s = new Set();
    sickMedEntries.forEach((e) => { if (e.day) s.add(dateKey(year, month, e.day)); });
    return s;
  }, [sickMedEntries, year, month]);
  const sickMedProtectedDayCodes = useMemo(() => {
    const m = new Map();
    sickMedEntries.forEach((e) => { if (e.day) m.set(dateKey(year, month, e.day), e.type); });
    return m;
  }, [sickMedEntries, year, month]);

  // VAC/VAX days count as days off but can never be worked over — excluded from every
  // Add/swap-in eligibility check separately from the ordinary days-off availability check.
  const vacationDateKeys = useMemo(() => {
    const base = scheduleParsed ? scheduleParsed.vacationDays : new Set();
    return sickMedProtectedDateKeys.size ? new Set([...base, ...sickMedProtectedDateKeys]) : base;
  }, [scheduleParsed, sickMedProtectedDateKeys]);
  const protectedDayCodes = useMemo(() => {
    const base = scheduleParsed && scheduleParsed.protectedDayCodes ? scheduleParsed.protectedDayCodes : new Map();
    return sickMedProtectedDayCodes.size ? new Map([...base, ...sickMedProtectedDayCodes]) : base;
  }, [scheduleParsed, sickMedProtectedDayCodes]);
  function overlapsVacation(dateKeys) { return dateKeys.some((k) => vacationDateKeys.has(k)); }

  // Every schedule-paste BER day's guaranteed (first-3-per-occurrence) credit, unconditional.
  const berGuaranteedHours = useMemo(() => (scheduleParsed ? berGuaranteedCredit(scheduleParsed) : 0), [scheduleParsed]);
  // Sick Start dispersal: Sick/MED entries (binary -- fully covered or fully not, per day) and
  // BER's day-4/day-5 slots (partial -- covers whatever's left in the bank, never subtracts the
  // rest) merged into one chronological pool and drained in date order. Recomputed fresh from
  // scratch every render, same as every other preference check in this tool -- never a running
  // total mutated in place, so editing or removing an entry just naturally updates everything
  // downstream on the next render.
  const sickDispersal = useMemo(() => {
    const startHours = parseCreditToHours(sickBankStart);
    const berSlots = scheduleParsed ? berExtraDaySlots(scheduleParsed) : [];
    const items = [
      ...sickMedEntries.map((e) => ({ kind: "sickmed", id: e.id, dateKey: dateKey(year, month, e.day), neededHours: parseCreditToHours(e.hoursRaw), entry: e })),
      ...berSlots.map((s, i) => ({ kind: "ber", id: `ber-${s.dateKey}-${i}`, dateKey: s.dateKey, neededHours: s.neededHours })),
    ].filter((it) => it.neededHours != null).sort((a, b) => a.dateKey.localeCompare(b.dateKey));

    if (startHours == null) {
      // No Sick Start entered yet -- nothing can be determined, so nothing is credited or
      // subtracted until a balance is actually provided to disperse.
      return { results: items.map((it) => ({ ...it, covered: null, coveredHours: 0 })), creditDelta: 0, remaining: null, startHours: null };
    }
    let remaining = startHours;
    let creditDelta = 0;
    const results = items.map((it) => {
      if (it.kind === "sickmed") {
        if (remaining >= it.neededHours) {
          creditDelta += it.neededHours; remaining -= it.neededHours;
          return { ...it, covered: true, coveredHours: it.neededHours };
        }
        creditDelta -= it.neededHours;
        return { ...it, covered: false, coveredHours: 0 };
      }
      const used = Math.min(remaining, it.neededHours);
      creditDelta += used; remaining -= used;
      return { ...it, covered: used >= it.neededHours, coveredHours: used };
    });
    return { results, creditDelta, remaining, startHours };
  }, [sickBankStart, sickMedEntries, scheduleParsed, year, month]);
  const sickAndBerCreditDelta = berGuaranteedHours + sickDispersal.creditDelta;

  // Only injected (Open Time/Trade Board sourced) trips carry known clock times — the original
  // FLICA schedule import has no report/arrival times at all, so rest can't be verified against
  // those days. reportByDate covers a trip's first day; arriveByDate covers its last day, using
  // the first-day arrival as an approximation for multi-day trips since a true last-day arrival
  // isn't available from the Open Time board's summary view.
  const dutyReportByDate = useMemo(() => {
    const m = new Map();
    liveTrips.forEach((t) => {
      if (t.report) m.set(dateKey(t.startYear, t.startMonth, t.startDay), t.report);
    });
    return m;
  }, [liveTrips]);
  const dutyArriveByDate = useMemo(() => {
    const m = new Map();
    liveTrips.forEach((t) => {
      if (t.arrive) {
        const keys = scheduleTripDateKeys(t);
        m.set(keys[keys.length - 1], t.arrive);
      }
    });
    return m;
  }, [liveTrips]);

  function violatesRestRule(dateKeys, report, arrive) {
    if (!dateKeys.length) return false;
    const startKey = dateKeys[0], endKey = dateKeys[dateKeys.length - 1];
    const priorArrive = dutyArriveByDate.get(adjacentDateKey(startKey, -1));
    if (priorArrive && report) {
      const rest = restHours(adjacentDateKey(startKey, -1), priorArrive, startKey, report);
      if (rest != null && rest < MIN_REST_HOURS) return true;
    }
    const nextReport = dutyReportByDate.get(adjacentDateKey(endKey, 1));
    if (nextReport && arrive) {
      const rest = restHours(endKey, arrive, adjacentDateKey(endKey, 1), nextReport);
      if (rest != null && rest < MIN_REST_HOURS) return true;
    }
    return false;
  }

  // Would picking up this candidate's days drop the bid month's remaining days off below the
  // configured floor (effectiveMinDaysOff)? Checked against the current actual daysOff count for
  // the month, same style as exceedsMaxStreak/violatesMinRest -- not simulated against any other
  // still-pending pick, only against what's really on the schedule right now.
  function violatesMinDaysOffFloor(dateKeys) {
    if (!effectiveMinDaysOff || !dateKeys.length) return false;
    const monthPrefix = `${year}-${pad2(month + 1)}`;
    const currentOffThisMonth = [...daysOff].filter((k) => k.startsWith(monthPrefix)).length;
    const consumedThisMonth = dateKeys.filter((k) => k.startsWith(monthPrefix)).length;
    return currentOffThisMonth - consumedThisMonth < effectiveMinDaysOff;
  }

  // violatesRestRule only catches conflicts against what's already live (dutyReportByDate/
  // dutyArriveByDate come from liveTrips) -- it has no way to see a conflict against some OTHER
  // still-pending suggestion, since that trip isn't on the schedule yet either. A "possible add"
  // unlocked by a swap can look perfectly clean on its own and still not actually fit once you
  // also accept some other Add sitting right next to it in the Opentime pot -- this finds that
  // case so it can be flagged with a note instead of silently letting both look independently fine.
  function findAdjacentRestConflict(t, candidates) {
    if (!t.dateKeys || !t.dateKeys.length) return null;
    const tStart = t.dateKeys[0], tEnd = t.dateKeys[t.dateKeys.length - 1];
    for (const other of candidates) {
      if (!other || other.id === t.id || !other.dateKeys || !other.dateKeys.length) continue;
      const oStart = other.dateKeys[0], oEnd = other.dateKeys[other.dateKeys.length - 1];
      if (adjacentDateKey(tStart, -1) === oEnd && other.arrive && t.report) {
        const rest = restHours(oEnd, other.arrive, tStart, t.report);
        if (rest != null && rest < MIN_REST_HOURS) return other;
      }
      if (adjacentDateKey(tEnd, 1) === oStart && other.report && t.arrive) {
        const rest = restHours(tEnd, t.arrive, oStart, other.report);
        if (rest != null && rest < MIN_REST_HOURS) return other;
      }
    }
    return null;
  }

  const droppableTrips = useMemo(() => {
    if (!scheduleParsed) return [];
    const injectedKeys = new Set(injectedTrips.map(tripKey));
    return liveTrips.map((t) => {
      const keys = scheduleTripDateKeys(t);
      const statuses = keys.map((k) => ({ key: k, status: gridStatus(k) }));
      const blocker = statuses.find((s) => !gridOkForMonth(s.key));
      const key = tripKey(t);
      const isSdo = sdoFlags.has(key);
      const isPremium = premiumFlags.has(key);
      const isLocked = lockedFlags.has(key);
      const wantsOverlap = keys.some((k) => wantedOff.has(k));
      const isInjected = injectedKeys.has(key);
      return { ...t, keys, droppable: !blocker && !isSdo && !isLocked, gridBlocked: !!blocker, blocker, key, isSdo, isPremium, isLocked, wantsOverlap, isInjected };
    });
  }, [scheduleParsed, liveTrips, injectedTrips, combinedGrid, sdoFlags, premiumFlags, lockedFlags, wantedOff, year, month]);

  const originalCalendarText = useMemo(() => {
    if (!scheduleParsed) return null;
    return renderFlicaCalendar(scheduleParsed.trips, scheduleParsed.daysOff.size, year, month, scheduleParsed.summary.credit, scheduleParsed.summary.block, false, scheduleParsed.vacationDays, scheduleParsed.protectedDayCodes);
  }, [scheduleParsed, year, month]);

  const updatedCalendarText = useMemo(() => {
    if (!scheduleParsed) return null;
    const offCountThisMonth = [...new Set([...daysOff, ...sickMedProtectedDateKeys])].filter((k) => k.startsWith(`${year}-${pad2(month + 1)}`)).length;
    // Matches the bold total shown alongside this panel (baselineHours) -- raw baselineCredit
    // alone would silently omit the always-fresh sick/BER credit delta, showing a different
    // number here than the one right next to it.
    const updatedTotalCreditHours = Math.max((parseFloat(baselineCredit) || 0) + sickAndBerCreditDelta, 0);
    return renderFlicaCalendar(liveTrips, offCountThisMonth, year, month, updatedTotalCreditHours.toFixed(2), scheduleParsed.summary.block, true, vacationDateKeys, protectedDayCodes);
  }, [scheduleParsed, liveTrips, daysOff, sickMedProtectedDateKeys, year, month, baselineCredit, sickAndBerCreditDelta, vacationDateKeys, protectedDayCodes]);

  function passesTimePref(t) {
    if (!applyTimePref) return true;
    const report = t.base ? convertTimeToBase(t.report, t.base, homeBase) : t.report;
    const arrive = t.base ? convertTimeToBase(t.arrive, t.base, homeBase) : t.arrive;
    if (minReport && report && report < minReport) return false;
    if (maxArrive && arrive && arrive > maxArrive) return false;
    return true;
  }

  const allOpenTrips = useMemo(() => {
    const extras = extraBoards.flatMap((b, bi) => [
      ...b.parsed.trips.map((t) => ({ ...t, id: `xb${bi}-${t.id}` })),
      ...b.imageRows.map((r) => { const t = rowToTrip(r, year); return { ...t, id: `xb${bi}-${t.id}` }; }),
    ]);
    return [...openParsed.trips, ...imageRows.map((r) => rowToTrip(r, year)), ...extras, ...droppedTripsPool];
  }, [openParsed, imageRows, extraBoards, year, droppedTripsPool]);

  const enrichedOpen = useMemo(() => {
    return allOpenTrips.map((t) => {
      const keys = tripDateKeys(t);
      const overlap = keys.filter((k) => daysOff.has(k)).length;
      const onVacation = overlapsVacation(keys);
      const eligible = !t.autoTB && keys.length > 0 && overlap === keys.length && !onVacation;
      const missing = keys.filter((k) => !daysOff.has(k));
      const pay = t.creditHours != null ? t.creditHours * hourlyRate : null;
      const perDay = pay != null && t.days > 0 ? pay / t.days : null;
      const simulatedWorking = new Set([...occupiedDateKeys, ...keys]);
      const exceedsMaxStreak = keys.length > 0 && longestConsecutiveRun(simulatedWorking) > effectiveMaxConsecutive;
      const violatesRest = violatesRestRule(keys, t.report, t.arrive);
      const violatesMinRest = keys.length > 0 && violatesMinRestGap(occupiedDateKeys, keys, effectiveMinRestDays);
      const violatesMinDaysOff = violatesMinDaysOffFloor(keys);
      return { ...t, dateKeys: keys, overlap, eligible, missing, pay, perDay, fitsTime: passesTimePref(t), usesWanted: keys.some((k) => wantedOff.has(k)), exceedsMaxStreak, violatesRest, violatesMinRest, violatesMinDaysOff, onVacation };
    });
  }, [allOpenTrips, daysOff, hourlyRate, wantedOff, applyTimePref, minReport, maxArrive, homeBase, occupiedDateKeys, dutyReportByDate, dutyArriveByDate, vacationDateKeys, effectiveMaxConsecutive, effectiveMinRestDays, effectiveMinDaysOff, year, month]);

  const eligibleSorted = useMemo(() => enrichedOpen.filter((t) => t.eligible && t.fitsTime && !t.exceedsMaxStreak && !t.violatesRest && !t.violatesMinRest && !t.violatesMinDaysOff && !deniedAddIds.has(t.id)).slice().sort((a, b) => (b.perDay || 0) - (a.perDay || 0)), [enrichedOpen, deniedAddIds]);
  const nearMiss = useMemo(() => enrichedOpen.filter((t) => !t.eligible && !t.autoTB && t.start && t.overlap > 0 && t.fitsTime && !t.exceedsMaxStreak && !t.violatesRest && !t.violatesMinRest && !t.violatesMinDaysOff && !deniedAddIds.has(t.id)).slice().sort((a, b) => a.missing.length - b.missing.length), [enrichedOpen, deniedAddIds]);
  const maxStreakBlockedCount = enrichedOpen.filter((t) => t.eligible && t.exceedsMaxStreak).length;
  const restBlockedCount = enrichedOpen.filter((t) => t.eligible && !t.exceedsMaxStreak && t.violatesRest).length;
  const minRestBlockedCount = enrichedOpen.filter((t) => t.eligible && !t.exceedsMaxStreak && !t.violatesRest && t.violatesMinRest).length;
  const minDaysOffBlockedCount = enrichedOpen.filter((t) => t.eligible && !t.exceedsMaxStreak && !t.violatesRest && !t.violatesMinRest && t.violatesMinDaysOff).length;
  const autoFlaggedTB = enrichedOpen.filter((t) => t.autoTB);

  const allTradeTrips = useMemo(() => {
    const extras = extraTradeBoards.flatMap((b, bi) => b.parsed.trips.map((t) => ({ ...t, id: `xtb${bi}-${t.id}` })));
    return [...tradeParsed.trips, ...extras];
  }, [tradeParsed, extraTradeBoards]);

  const enrichedTrade = useMemo(() => {
    return allTradeTrips.map((t) => {
      const keys = tripDateKeys(t);
      const overlap = keys.filter((k) => daysOff.has(k)).length;
      const exceedsMaxStreak = keys.length > 0 && longestConsecutiveRun(new Set([...occupiedDateKeys, ...keys])) > effectiveMaxConsecutive;
      const violatesRest = violatesRestRule(keys, t.report, t.arrive);
      const violatesMinRest = keys.length > 0 && violatesMinRestGap(occupiedDateKeys, keys, effectiveMinRestDays);
      const violatesMinDaysOff = violatesMinDaysOffFloor(keys);
      const onVacation = overlapsVacation(keys);
      const feasible = keys.length > 0 && overlap === keys.length && !exceedsMaxStreak && !violatesRest && !violatesMinRest && !violatesMinDaysOff && !onVacation;
      const missing = keys.filter((k) => !daysOff.has(k));
      return { ...t, dateKeys: keys, overlap, feasible, missing, fitsTime: passesTimePref(t), exceedsMaxStreak, violatesRest, violatesMinRest, violatesMinDaysOff, onVacation };
    }).filter((t) => t.fitsTime && !t.exceedsMaxStreak && !t.violatesRest && !t.violatesMinRest && !t.violatesMinDaysOff && !t.onVacation);
  }, [allTradeTrips, daysOff, applyTimePref, minReport, maxArrive, homeBase, occupiedDateKeys, dutyReportByDate, dutyArriveByDate, vacationDateKeys, effectiveMaxConsecutive, effectiveMinRestDays, effectiveMinDaysOff, year, month]);

  const usedDateKeys = useMemo(() => {
    const s = new Set();
    selected.forEach((id) => { const t = enrichedOpen.find((x) => x.id === id); if (t) t.dateKeys.forEach((k) => s.add(k)); });
    return s;
  }, [selected, enrichedOpen]);

  const acceptedUsedDateKeys = useMemo(() => {
    const s = new Set();
    acceptedAdds.forEach((id) => { const t = enrichedOpen.find((x) => x.id === id); if (t) t.dateKeys.forEach((k) => s.add(k)); });
    return s;
  }, [acceptedAdds, enrichedOpen]);
  function acceptedConflicts(trip) { return trip.dateKeys.some((k) => acceptedUsedDateKeys.has(k) && !acceptedAdds.has(trip.id)); }

  function toggleSelect(trip) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(trip.id)) { n.delete(trip.id); removeFromPlannedOrder("add", trip.id); }
      else { n.add(trip.id); addToPlannedOrder("add", trip.id); }
      return n;
    });
  }

  // ---- Swap recommendations: droppable, non-SDO trips paired with the cheapest open-time swap-in ----
  // Every day currently committed to ANY live trip — a valid swap-in must never land on one of
  // these days unless that day belongs to the specific pair being dropped (which frees it up).

  // A trip doesn't need to be fully green on its own to be part of a drop pair — only the days
  // that end up genuinely freed (not covered by whatever swap-in replaces them) need to be green.
  // SDO trips are still excluded outright, since dropping one gives back an already-earned bonus.
  const swapRecs = droppableTrips.filter((t) => !t.isSdo && !t.isLocked);
  const swapPairs = [];
  for (let i = 0; i < swapRecs.length; i++) {
    for (let j = i + 1; j < swapRecs.length; j++) {
      const a = swapRecs[i], b = swapRecs[j];
      const pairKeyStr = `${a.key}__${b.key}`;
      // Denial is tracked per row (pair + specific swap-in, "pairKey::swapInId" -- see
      // toggleDeniedSwap) not per pair, since the same two dropped trips can have several
      // different swap-in options and only one of those needs to be denied. Filtered below,
      // once each row's actual key exists, not here.
      swapPairs.push({ a, b, pairKey: pairKeyStr, totalDaysFreed: a.days + b.days, wantsOverlap: a.wantsOverlap || b.wantsOverlap });
    }
  }
  swapPairs.sort((x, y) => (x.wantsOverlap !== y.wantsOverlap ? (x.wantsOverlap ? -1 : 1) : y.totalDaysFreed - x.totalDaysFreed));
  const swapPairsByKey = new Map(swapPairs.map((p) => [p.pairKey, p]));

  // A swap never earns SDO on its own (see the SDO pay rule above) — the only reason to surface
  // one at all is that it manufactures day(s) off a later Add could land on. So a swap is only
  // worth recommending if the Opentime pot actually has something, right now, that would become
  // a genuinely SDO-eligible Add (fully covered by current days off + the days this swap frees)
  // AND clears every other active preference the same way a normal Add would have to. This is the
  // single source of truth for that check — both swapInGroups and multiSwapInOptions filter on it
  // (attaching the result as row.unlockedAdds) rather than each recomputing their own copy.
  function computeUnlockedAdds(dropKeys, freedKeys, swapInTrips) {
    const postSwapOccupied = new Set([...occupiedDateKeys].filter((k) => !dropKeys.includes(k)));
    swapInTrips.forEach((si) => tripDateKeys(si).forEach((k) => postSwapOccupied.add(k)));
    return enrichedOpen
      .filter((t) => !t.autoTB && t.fitsTime && t.dateKeys.length > 0 && !t.eligible && !t.onVacation && !t.violatesMinDaysOff && !deniedAddIds.has(t.id) && t.dateKeys.every((k) => daysOff.has(k) || freedKeys.includes(k)))
      .filter((t) => longestConsecutiveRun(new Set([...postSwapOccupied, ...t.dateKeys])) <= effectiveMaxConsecutive)
      .filter((t) => !violatesMinRestGap(postSwapOccupied, t.dateKeys, effectiveMinRestDays))
      .filter((t) => !t.violatesRest)
      .filter((t) => {
        const tStart = t.dateKeys[0], tEnd = t.dateKeys[t.dateKeys.length - 1];
        return swapInTrips.every((si) => {
          const siKeys = tripDateKeys(si);
          const siStart = siKeys[0], siEnd = siKeys[siKeys.length - 1];
          if (adjacentDateKey(tStart, -1) === siEnd && si.arrive && t.report) {
            const rest = restHours(siEnd, si.arrive, tStart, t.report);
            if (rest != null && rest < MIN_REST_HOURS) return false;
          }
          if (adjacentDateKey(tEnd, 1) === siStart && si.report && t.arrive) {
            const rest = restHours(tEnd, t.arrive, siStart, si.report);
            if (rest != null && rest < MIN_REST_HOURS) return false;
          }
          return true;
        });
      });
  }

  // Group every valid (pair, swap-in) combination by the swap-in trip, so all the ways to
  // manufacture the same days off sit together, ranked by how many days they free. Every valid
  // combination is computed and kept — the caps below are a generous safety limit on rendering,
  // not a filter, and any actual truncation is shown explicitly rather than silently dropped.
  const swapInGroups = useMemo(() => {
    const candidates = allOpenTrips.filter((t) => t.creditHours != null && !t.autoTB && t.start);
    const identityKey = (pairing, dtok) => `${pairing}|${dtok}`;
    const occurrenceCount = new Map();
    candidates.forEach((t) => {
      const k = identityKey(t.pairing, t.dateTok);
      occurrenceCount.set(k, (occurrenceCount.get(k) || 0) + 1);
    });
    const groups = [];
    candidates.forEach((s) => {
      const sKeys = tripDateKeys(s);
      if (!sKeys.length) return;
      if (violatesRestRule(sKeys, s.report, s.arrive)) return;
      if (overlapsVacation(sKeys)) return;
      const sIdentity = identityKey(s.pairing, s.dateTok);
      const allMatchingPairs = swapPairs
        .filter((p) => {
          const aIdentity = identityKey(p.a.pairing, `${pad2(p.a.startDay)}${MONTHS[p.a.startMonth]}`);
          const bIdentity = identityKey(p.b.pairing, `${pad2(p.b.startDay)}${MONTHS[p.b.startMonth]}`);
          if ((sIdentity === aIdentity || sIdentity === bIdentity) && (occurrenceCount.get(sIdentity) || 0) < 2) return false;
          const freeable = new Set([...p.a.keys, ...p.b.keys]);
          // Swap-in can't collide with any OTHER trip still on the schedule.
          if (!sKeys.every((k) => !occupiedDateKeys.has(k) || freeable.has(k))) return false;
          // Only days that truly end up freed (not covered by the swap-in) need to be green —
          // a black/red day is fine as long as the swap-in continues to provide coverage there.
          const trulyFreed = [...freeable].filter((k) => !sKeys.includes(k));
          if (!trulyFreed.every((k) => gridOkForMonth(k))) return false;
          const postDropOccupied = new Set([...occupiedDateKeys].filter((k) => !freeable.has(k)));
          if (longestConsecutiveRun(new Set([...postDropOccupied, ...sKeys])) > effectiveMaxConsecutive) return false;
          return !violatesMinRestGap(postDropOccupied, sKeys, effectiveMinRestDays);
        })
        .map((p) => {
          const freedKeys = [...p.a.keys, ...p.b.keys].filter((k) => !sKeys.includes(k));
          const unlockedAdds = computeUnlockedAdds([...p.a.keys, ...p.b.keys], freedKeys, [s]);
          return { pair: p, swapIn: s, swapIns: [s], rowKey: `${p.pairKey}::${s.id}`, freedKeys, freedCount: freedKeys.length, unlockedAdds };
        })
        .filter((row) => !deniedSwapKeys.has(row.rowKey))
        // Only worth recommending if it actually unlocks a currently SDO-eligible, preference-passing Add.
        .filter((row) => row.unlockedAdds.length > 0)
        .sort((a, b) => b.freedCount - a.freedCount);
      if (allMatchingPairs.length) groups.push({ swapIn: s, rows: allMatchingPairs });
    });
    // Rows within a group are already sorted by freedCount descending (see the .sort right
    // above), so each group's own best option -- and therefore its max potential days freed --
    // is always rows[0]. Groups themselves are ranked the same way: whichever swap-in can free
    // the most days first, cheapest credit as the tiebreaker.
    groups.sort((a, b) => b.rows[0].freedCount - a.rows[0].freedCount || (a.swapIn.creditHours || 0) - (b.swapIn.creditHours || 0));
    return groups;
  }, [allOpenTrips, swapPairs, occupiedDateKeys, dutyReportByDate, dutyArriveByDate, vacationDateKeys, effectiveMaxConsecutive, effectiveMinRestDays, deniedSwapKeys, enrichedOpen, daysOff, deniedAddIds, year, month]);

  const pairsWithSingleMatch = useMemo(() => {
    const s = new Set();
    swapInGroups.forEach((g) => g.rows.forEach((r) => s.add(r.pair.pairKey)));
    return s;
  }, [swapInGroups]);

  // Fallback for when no single open-time trip covers everything needed: try combining two
  // trips together as the swap-in. Only attempted for pairs with no single-trip match, since
  // this is strictly more expensive and a single clean pickup is always the simpler ask.
  const multiSwapInOptions = useMemo(() => {
    const needMulti = swapPairs.filter((p) => !pairsWithSingleMatch.has(p.pairKey));
    if (!needMulti.length) return [];
    // Same identity check as swapInGroups above -- without it, a candidate that's actually one
    // of the two trips being dropped (same pairing+date) can be offered back as its own swap-in,
    // producing a nonsensical "drop X, swap into X" row that frees 0 days. Worse, accepting one
    // makes the trip flip between "original" and "injected" on every render, so its rowKey never
    // stays stable and the row's checkboxes can never be unchecked once checked. The occurrence-
    // count escape hatch still allows a genuinely duplicated pot listing (two open seats on the
    // same pairing/date) to be picked up.
    const identityKey = (pairing, dtok) => `${pairing}|${dtok}`;
    const rawCandidates = allOpenTrips.filter((t) => t.creditHours != null && !t.autoTB && t.start);
    const occurrenceCount = new Map();
    rawCandidates.forEach((t) => {
      const k = identityKey(t.pairing, t.dateTok);
      occurrenceCount.set(k, (occurrenceCount.get(k) || 0) + 1);
    });
    const candidates = rawCandidates
      .map((t) => ({ t, keys: tripDateKeys(t) }))
      .filter(({ keys, t }) => keys.length > 0 && !violatesRestRule(keys, t.report, t.arrive) && !overlapsVacation(keys));

    const results = [];
    needMulti.forEach((p) => {
      const freeable = new Set([...p.a.keys, ...p.b.keys]);
      const aIdentity = identityKey(p.a.pairing, `${pad2(p.a.startDay)}${MONTHS[p.a.startMonth]}`);
      const bIdentity = identityKey(p.b.pairing, `${pad2(p.b.startDay)}${MONTHS[p.b.startMonth]}`);
      const isDroppedIdentity = (t) => {
        const tid = identityKey(t.pairing, t.dateTok);
        return (tid === aIdentity || tid === bIdentity) && (occurrenceCount.get(tid) || 0) < 2;
      };
      const found = [];
      for (let i = 0; i < candidates.length; i++) {
        for (let j = i + 1; j < candidates.length; j++) {
          const c1 = candidates[i], c2 = candidates[j];
          if (isDroppedIdentity(c1.t) || isDroppedIdentity(c2.t)) continue;
          if (c1.t.pairing === c2.t.pairing && c1.t.dateTok === c2.t.dateTok) continue;
          if (c1.keys.some((k) => c2.keys.includes(k))) continue; // the two swap-ins can't overlap each other
          const combined = new Set([...c1.keys, ...c2.keys]);
          const conflictsOther = [...combined].some((k) => occupiedDateKeys.has(k) && !freeable.has(k));
          if (conflictsOther) continue;
          const trulyFreed = [...freeable].filter((k) => !combined.has(k));
          if (!trulyFreed.every((k) => gridOkForMonth(k))) continue;
          const postDropOccupied = new Set([...occupiedDateKeys].filter((k) => !freeable.has(k)));
          const combinedOccupied = new Set([...postDropOccupied, ...combined]);
          if (longestConsecutiveRun(combinedOccupied) > effectiveMaxConsecutive) continue;
          if (violatesMinRestGap(postDropOccupied, [...combined], effectiveMinRestDays)) continue;
          const freedKeys = [...freeable].filter((k) => !combined.has(k));
          const rowKey = `${p.pairKey}::${c1.t.id}+${c2.t.id}`;
          if (deniedSwapKeys.has(rowKey)) continue;
          const unlockedAdds = computeUnlockedAdds([...p.a.keys, ...p.b.keys], freedKeys, [c1.t, c2.t]);
          // Same rule as swapInGroups -- only worth recommending if it unlocks a currently
          // SDO-eligible, preference-passing Add.
          if (unlockedAdds.length === 0) continue;
          found.push({
            pair: p, swapIns: [c1.t, c2.t], rowKey,
            freedKeys, freedCount: freedKeys.length, unlockedAdds,
          });
        }
      }
      results.push(...found);
    });
    return results;
  }, [swapPairs, pairsWithSingleMatch, allOpenTrips, occupiedDateKeys, vacationDateKeys, dutyReportByDate, dutyArriveByDate, effectiveMaxConsecutive, effectiveMinRestDays, deniedSwapKeys, enrichedOpen, daysOff, deniedAddIds, year, month]);

  const multiSwapRowsByKey = useMemo(() => {
    const m = new Map();
    multiSwapInOptions.forEach((r) => m.set(r.rowKey, r));
    return m;
  }, [multiSwapInOptions]);

  const swapRowsByKey = useMemo(() => {
    const m = new Map();
    swapInGroups.forEach((g) => g.rows.forEach((r) => m.set(r.rowKey, r)));
    return m;
  }, [swapInGroups]);

  const combinedSwapRowsByKey = useMemo(() => {
    return new Map([...swapRowsByKey, ...multiSwapRowsByKey]);
  }, [swapRowsByKey, multiSwapRowsByKey]);

  // Days a currently-Planned (checked, not yet Approved) swap's swap-in would occupy. Planning
  // a swap doesn't touch daysOff itself -- only Approving does -- so an Add landing on one of
  // these days still looks perfectly fine on its own right now, but would stop being possible
  // the moment that specific swap actually goes through. Kept purely informational: Planned is
  // easy to uncheck, so this never removes or disables the Add, just names which swap causes it.
  const plannedSwapOccupiedBy = useMemo(() => {
    const m = new Map();
    selectedSwaps.forEach((rowKey) => {
      const row = combinedSwapRowsByKey.get(rowKey);
      if (!row) return;
      const { pair, swapIns } = row;
      const label = `Drop ${pair.a.pairing} + ${pair.b.pairing} → swap into ${swapIns.map((si) => si.pairing).join(" + ")}`;
      const swapInIds = new Set(swapIns.map((si) => si.id));
      swapIns.forEach((si) => {
        tripDateKeys(si).forEach((k) => {
          if (!m.has(k)) m.set(k, []);
          m.get(k).push({ label, rowKey, swapInIds });
        });
      });
    });
    return m;
  }, [selectedSwaps, combinedSwapRowsByKey]);
  function getPlannedSwapConflict(t) {
    if (!t.dateKeys) return null;
    for (const k of t.dateKeys) {
      const entries = plannedSwapOccupiedBy.get(k);
      if (!entries) continue;
      const hit = entries.find((e) => !e.swapInIds.has(t.id));
      if (hit) return hit;
    }
    return null;
  }

  // Planned (but not yet Approved) swaps never touch baselineCredit -- only accepting one does --
  // and several Planned rows are very often mutually-exclusive alternatives for the same end
  // result (different drop pairs that all swap into the same trip, or otherwise manufacture the
  // same days off), not swaps the user actually intends to stack together. Only one of them will
  // ever really go through FLICA, so the 60-hour floor is checked per row against the real
  // current baseline alone -- never inflated by what else happens to be Planned right now. This
  // is deliberate: it lets every alternative be marked Planned freely to compare/prioritize them
  // below, and the floor only actually blocks anything once a swap is truly Approved (which does
  // mutate baselineCredit for real, so the next projection is naturally checked against that).
  // Uses baselineHours (baselineCredit plus the always-fresh sick/BER credit delta), not raw
  // baselineCredit alone -- otherwise an uncovered Sick/MED day that's already dragging the real
  // worked total under 60 could be invisible here, silently letting a swap through that drops the
  // true total even further below the floor.
  function projectedHoursIfSwapPlanned(pair, swapIns) {
    const adj = computeSwapCreditAdjustment(pair, swapIns);
    if (adj == null) return null;
    return baselineHours + adj;
  }

  // ---- Floor-fix suggestions: when a swap would drop worked hours under 60, surface the
  // cheapest concrete way to add enough credit first so the swap clears the floor -- an Add,
  // a Trade Board pickup, or a Bilateral Trade, each already-known-credit, never guessed at.
  function bestFloorFit(items, shortfall, getCredit) {
    let best = null;
    items.forEach((it) => {
      const c = getCredit(it);
      if (c == null || c < shortfall) return;
      if (best == null || c < getCredit(best)) best = it;
    });
    return best;
  }
  const floorFixTradeBoardCandidates = useMemo(() => enrichedTrade.filter((t) => t.feasible), [enrichedTrade]);
  // Every (one of your droppable trips) x (every board/pot trip) combination, kept only where
  // both credits are known -- same data limitation computeSwapCreditAdjustment already respects.
  // Sorted ascending by net credit change so the cheapest fix for any shortfall is found first.
  const floorFixBilateralCandidates = useMemo(() => {
    const outgoingCandidates = droppableTrips.filter((t) => !t.isSdo && !t.isLocked && parseCreditToHours(sdoTripCredits.get(t.key)) != null);
    const incomingCandidates = [
      ...allOpenTrips.filter((t) => !t.autoTB && t.creditHours != null),
      ...allTradeTrips.filter((t) => t.creditHours != null),
    ];
    const pairs = [];
    outgoingCandidates.forEach((o) => {
      const outCredit = parseCreditToHours(sdoTripCredits.get(o.key));
      incomingCandidates.forEach((inc) => {
        pairs.push({ outgoing: o, incoming: inc, outCredit, delta: (inc.creditHours || 0) - outCredit });
      });
    });
    pairs.sort((a, b) => a.delta - b.delta);
    return pairs;
  }, [droppableTrips, sdoTripCredits, allOpenTrips, allTradeTrips]);
  function getFloorFixSuggestions(shortfall, excludeKeys) {
    if (shortfall == null || shortfall <= 0) return [];
    const suggestions = [];
    const addFix = bestFloorFit(eligibleSorted, shortfall, (t) => t.creditHours);
    if (addFix) suggestions.push({ kind: "add", label: `Accept the Add ${addFix.pairing} (${formatHours(addFix.creditHours)}) from the Opentime pot`, credit: addFix.creditHours });
    const tbFix = bestFloorFit(floorFixTradeBoardCandidates, shortfall, (t) => t.creditHours);
    if (tbFix) suggestions.push({ kind: "tbadd", label: `Accept the Trade Board pickup ${tbFix.pairing} (${formatHours(tbFix.creditHours)})`, credit: tbFix.creditHours });
    // A "Trade Board" listing is almost never actually a swap-for-swap request -- most posters
    // just want the trip gone entirely (a straight drop, which is really a plain non-SDO Add for
    // whoever picks it up). This tool has no way to tell which one a given listing is from the
    // pairing/credit data alone, so this suggestion is only ever a starting point, never a
    // confirmed match -- the render side attaches an explicit warning to check FLICA directly.
    const bilateralFix = floorFixBilateralCandidates.find((p) => p.delta >= shortfall && !excludeKeys.includes(p.outgoing.key));
    if (bilateralFix) {
      suggestions.push({
        kind: "trade",
        label: `Trade away ${bilateralFix.outgoing.pairing} (${formatHours(bilateralFix.outCredit)}) for ${bilateralFix.incoming.pairing} (${formatHours(bilateralFix.incoming.creditHours)}) — net +${formatHours(bilateralFix.delta)}`,
        credit: bilateralFix.delta,
      });
    }
    return suggestions;
  }

  // A Trade Board post isn't a net removal of coverage — whoever picks it up takes over the
  // exact same days, so the Reserve Grid buffer is never actually affected. Only SDO/Premium matter here.
  const tradePostCandidates = droppableTrips.filter((t) => !t.isSdo && !t.isPremium && !t.isLocked);
  const sdoExcludedCount = droppableTrips.filter((t) => t.isSdo).length;
  const gridBlockedCount = droppableTrips.filter((t) => !t.droppable && !t.isSdo && t.gridBlocked).length;
  const gridUnknownCount = droppableTrips.filter((t) => !t.droppable && !t.isSdo && !t.gridBlocked).length;

  // ---- Priority projection: only the single highest-priority planned entry is ever shown on the
  // Planned preview -- never a stack of several non-conflicting lower-priority picks layered
  // together. Several Planned rows are very often mutually-exclusive alternatives for the same
  // end result (see the 60-hour floor note above), so previewing more than one of them at once as
  // if they'd all really happen would be misleading. Reorder "Your plan" below to preview a
  // different pick. Accepted changes are handled entirely separately (already baked into
  // daysOff/baseline) and always count, regardless of this.
  const projection = useMemo(() => {
    const activeOrder = plannedOrder.filter((e) => (e.type === "add" ? !acceptedAdds.has(e.id) && !deniedAddIds.has(e.id) : !acceptedSwaps.has(e.id) && !deniedSwapKeys.has(e.id)));
    const includedAddIds = new Set();
    const includedSwapKeys = new Set();
    const resolved = [];
    let topIncluded = false;

    activeOrder.forEach((entry, idx) => {
      if (topIncluded) {
        const label = entry.type === "swap"
          ? (() => {
              const row = combinedSwapRowsByKey.get(entry.id);
              return row ? `Drop ${row.pair.a.pairing} + ${row.pair.b.pairing} → ${row.swapIns.map((si) => si.pairing).join(" + ")}` : "(no longer available)";
            })()
          : (() => {
              const t = enrichedOpen.find((x) => x.id === entry.id);
              return t ? `${t.pairing} (${t.dateTok})` : "(no longer available)";
            })();
        resolved.push({ ...entry, rank: idx + 1, included: false, label, reason: "Only the top-priority planned pick is shown on the preview — reorder \"Your plan\" below to preview this one instead." });
        return;
      }
      if (entry.type === "swap") {
        const row = combinedSwapRowsByKey.get(entry.id);
        if (!row) { resolved.push({ ...entry, rank: idx + 1, included: false, label: "(no longer available)", reason: "This swap no longer qualifies." }); return; }
        const { pair, swapIns } = row;
        const label = `Drop ${pair.a.pairing} + ${pair.b.pairing} → ${swapIns.map((si) => si.pairing).join(" + ")}`;
        includedSwapKeys.add(entry.id);
        resolved.push({ ...entry, rank: idx + 1, included: true, label });
        topIncluded = true;
      } else {
        const t = enrichedOpen.find((x) => x.id === entry.id);
        if (!t) { resolved.push({ ...entry, rank: idx + 1, included: false, label: "(no longer available)", reason: "This trip no longer qualifies." }); return; }
        const label = `${t.pairing} (${t.dateTok})`;
        const fits = t.dateKeys.length > 0 && t.dateKeys.every((k) => daysOff.has(k));
        if (!fits) { resolved.push({ ...entry, rank: idx + 1, included: false, label, reason: "This trip no longer qualifies." }); return; }
        includedAddIds.add(entry.id);
        resolved.push({ ...entry, rank: idx + 1, included: true, label });
        topIncluded = true;
      }
    });
    return { includedAddIds, includedSwapKeys, resolved };
  }, [plannedOrder, combinedSwapRowsByKey, enrichedOpen, daysOff, acceptedAdds, acceptedSwaps, deniedAddIds, deniedSwapKeys]);

  const selectedTrips = enrichedOpen.filter((t) => selected.has(t.id));
  const projectedTrips = enrichedOpen.filter((t) => projection.includedAddIds.has(t.id));
  const swapDependentSelected = projectedTrips.filter((t) => !t.eligible).length;
  const acceptedTrips = enrichedOpen.filter((t) => acceptedAdds.has(t.id));
  const acceptedCreditHours = acceptedTrips.reduce((s, t) => s + (t.creditHours || 0), 0);
  const acceptedBonusPay = acceptedTrips.reduce((s, t) => s + (t.pay || 0), 0);
  // Add credit is straightforward (each trip's own creditHours), but a Planned swap only shows up
  // here if it actually survived the priority resolution above (projection.includedSwapKeys) --
  // a swap that lost out to a higher-priority conflicting pick contributes nothing, same as it
  // contributes nothing to the calendar grid itself. Without this, checking "Planned" on a swap
  // moved the calendar's worked days around but left the credit-hours total underneath it frozen,
  // since that total only ever summed Add trips.
  const totalSwapCreditDelta = useMemo(() => {
    let sum = 0;
    projection.includedSwapKeys.forEach((key) => {
      const row = combinedSwapRowsByKey.get(key);
      if (!row) return;
      const adj = computeSwapCreditAdjustment(row.pair, row.swapIns);
      if (adj != null) sum += adj;
    });
    return sum;
  }, [projection.includedSwapKeys, combinedSwapRowsByKey, sdoTripCredits]);
  const totalCreditHours = projectedTrips.reduce((s, t) => s + (t.creditHours || 0), 0) + totalSwapCreditDelta;
  const totalBonusPay = projectedTrips.reduce((s, t) => s + (t.pay || 0), 0);
  const baselineHours = Math.max((parseFloat(baselineCredit) || 0) + sickAndBerCreditDelta, 0);
  const workedHours = baselineHours + totalCreditHours;
  const belowFloor = workedHours > 0 && workedHours < 60;
  const daysOffUsed = usedDateKeys.size;
  const daysOffMarked = daysOff.size;

  // A non-destructive preview: what the schedule would look like if every top-priority,
  // non-conflicting planned Add and Swap (per the projection above) actually went through,
  // layered on top of the live (already-accepted) schedule. Nothing here touches real state.
  const plannedTrips = useMemo(() => {
    let trips = [...liveTrips];
    projection.resolved.filter((e) => e.included).forEach((entry) => {
      if (entry.type === "swap") {
        const row = combinedSwapRowsByKey.get(entry.id);
        if (!row) return;
        const { pair, swapIns } = row;
        trips = trips.filter((t) => tripKey(t) !== pair.a.key && tripKey(t) !== pair.b.key);
        swapIns.forEach((si) => {
          trips.push({
            pairing: si.pairing, startYear: si.start.year, startMonth: si.start.month, startDay: si.start.day,
            days: si.days, destinations: buildDestinations(si.layover, si.days),
          });
        });
      } else {
        const t = enrichedOpen.find((x) => x.id === entry.id);
        if (!t) return;
        trips.push({
          pairing: t.pairing, startYear: t.start.year, startMonth: t.start.month, startDay: t.start.day,
          days: t.days, destinations: buildDestinations(t.layover, t.days),
        });
      }
    });
    return trips;
  }, [liveTrips, projection, combinedSwapRowsByKey, enrichedOpen]);

  const plannedDaysOffSet = useMemo(() => {
    const s = new Set([...daysOff, ...sickMedProtectedDateKeys]);
    projection.resolved.filter((e) => e.included).forEach((entry) => {
      if (entry.type === "swap") {
        const row = combinedSwapRowsByKey.get(entry.id);
        if (!row) return;
        const swapInKeys = row.swapIns.flatMap((si) => tripDateKeys(si));
        const freedKeys = [...row.pair.a.keys, ...row.pair.b.keys].filter((k) => !swapInKeys.includes(k));
        freedKeys.forEach((k) => s.add(k));
        swapInKeys.forEach((k) => s.delete(k));
      } else {
        const t = enrichedOpen.find((x) => x.id === entry.id);
        if (t) t.dateKeys.forEach((k) => s.delete(k));
      }
    });
    return s;
  }, [daysOff, sickMedProtectedDateKeys, projection, combinedSwapRowsByKey, enrichedOpen]);

  const plannedCalendarText = useMemo(() => {
    if (!scheduleParsed) return null;
    const offCountThisMonth = [...plannedDaysOffSet].filter((k) => k.startsWith(`${year}-${pad2(month + 1)}`)).length;
    return renderFlicaCalendar(plannedTrips, offCountThisMonth, year, month, workedHours.toFixed(2), scheduleParsed.summary.block, true, vacationDateKeys, protectedDayCodes);
  }, [scheduleParsed, plannedTrips, plannedDaysOffSet, year, month, workedHours, vacationDateKeys, protectedDayCodes]);

  // baselineHours already includes accepted Adds' credit (added at acceptance time), so the
  // actual total just needs the accepted SDO bonus added on top. The planned total layers the
  // still-pending, priority-resolved picks (both their worked credit and their SDO bonus) on top of that.
  const preExistingSdoBonusPay = useMemo(() => {
    let sum = 0;
    sdoFlags.forEach((key) => {
      const h = parseCreditToHours(sdoTripCredits.get(key));
      if (h != null) sum += h * hourlyRate;
    });
    return sum;
  }, [sdoFlags, sdoTripCredits, hourlyRate]);
  const preExistingSdoBonusHours = useMemo(() => {
    let sum = 0;
    sdoFlags.forEach((key) => {
      const h = parseCreditToHours(sdoTripCredits.get(key));
      if (h != null) sum += h;
    });
    return sum;
  }, [sdoFlags, sdoTripCredits]);
  const acceptedBonusHours = acceptedCreditHours;
  const confirmedBonusHours = acceptedBonusHours + preExistingSdoBonusHours;
  // Monthly guarantee: baselineHours is already the full actual worked total (it live-updates as
  // Adds get approved, so it never needs acceptedCreditHours added again). The 75-hour fixed
  // baseline only comes into play once SDO is actually involved — with no confirmed SDO at all,
  // confirmed credit hours is simply the real baseline, however high or low it is (working past 75
  // with zero SDO just means you're paid for the actual hours you worked, not capped down to 75).
  // Once SDO is involved and worked hours clear 75, the worked portion of pay is based on the
  // 75-hour floor instead of whatever's above it; under 75, pay is based on the real worked total.
  // The SDO bonus itself is always added on top, uncapped, either way.
  const confirmedWorkedHours = confirmedBonusHours > 0 && baselineHours >= GUARANTEE_HOURS ? GUARANTEE_HOURS : baselineHours;
  const totalConfirmedCreditHours = confirmedWorkedHours + confirmedBonusHours;
  const actualTotal = totalConfirmedCreditHours * hourlyRate;
  const plannedTotal = actualTotal + totalCreditHours * hourlyRate + totalBonusPay;

  return (
    <div className="doplan" data-theme={theme} style={{ fontFamily: "var(--sans)", background: "var(--bg)", color: "var(--text-primary)", padding: "28px 24px", borderRadius: 14, maxWidth: 960, margin: "0 auto", transition: "background 0.15s, color 0.15s" }}>
      <style>{`
        :root { --sans: -apple-system, "Inter", "Segoe UI", sans-serif; --mono: "IBM Plex Mono", "SF Mono", Menlo, monospace; }
        .doplan[data-theme="dark"] {
          --bg: #0F1419; --surface: #171D26; --btn-bg: #1D2B32; --btn-bg-hover: #22363E;
          --td-border: #1C222B; --row-hover: #141A21; --border: #2A323D; --teal: #2DD4BF;
          --border-teal-soft: #2A4A45; --border-amber-soft: #4A3A2A; --border-danger-soft: #3A2E2E;
          --text-primary: #E4E9EF; --text-secondary: #C9D2DE; --text-muted: #8A96A6; --text-faint: #5F6B7A;
          --teal-bright: #7FEAD8; --amber: #F0A868; --amber-strong: #E2A25C;
          --badge-amber-bg: #3A2E1A; --badge-red-bg: #3A1A1A;
          --cal-off-bg: rgba(45,212,191,0.16); --teal-tint: rgba(45,212,191,0.06); --amber-tint: rgba(226,162,92,0.06);
        }
        .doplan[data-theme="light"] {
          --bg: #F5F7FA; --surface: #FFFFFF; --btn-bg: #E3F4F1; --btn-bg-hover: #D2ECE7;
          --td-border: #E7EAEE; --row-hover: #EEF1F5; --border: #D7DCE3; --teal: #0E9488;
          --border-teal-soft: #BFE6DF; --border-amber-soft: #F0DCC0; --border-danger-soft: #F0D0D0;
          --text-primary: #1B2430; --text-secondary: #3D4756; --text-muted: #66707F; --text-faint: #8890A0;
          --teal-bright: #0B7E73; --amber: #B5650A; --amber-strong: #A85B08;
          --badge-amber-bg: #FBEAD2; --badge-red-bg: #FBDCDC;
          --cal-off-bg: rgba(14,148,136,0.14); --teal-tint: rgba(14,148,136,0.08); --amber-tint: rgba(181,101,10,0.08);
        }
        .doplan input[type=text], .doplan input[type=number], .doplan select {
          background: var(--surface); border: 1px solid var(--border); color: var(--text-primary);
          border-radius: 6px; padding: 7px 10px; font-family: var(--mono); font-size: 14px;
        }
        .doplan textarea {
          background: var(--surface); border: 1px solid var(--border); color: var(--text-secondary);
          border-radius: 6px; padding: 10px; font-family: var(--mono); font-size: 12px;
          width: 100%; box-sizing: border-box; resize: vertical;
        }
        .doplan button.action { background: var(--btn-bg); border: 1px solid var(--teal); color: var(--teal-bright); border-radius: 6px; padding: 8px 16px; font-family: var(--sans); font-size: 13px; cursor: pointer; font-weight: 500; }
        .doplan button.action:hover { background: var(--btn-bg-hover); }
        .doplan button.small { padding: 4px 10px; font-size: 12px; }
        .doplan table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .doplan th { text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 500; font-size: 12px; border-bottom: 1px solid var(--border); }
        .doplan td { padding: 8px 10px; border-bottom: 1px solid var(--td-border); font-family: var(--mono); }
        .doplan tr:hover { background: var(--row-hover); }
        .doplan .hint { font-size: 12px; color: var(--text-faint); margin-top: 8px; margin-bottom: 24px; line-height: 1.5; }
        .doplan .step { font-size: 11px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .doplan .h { font-size: 14px; font-weight: 500; margin-bottom: 10px; }
        .doplan label.chk { display: inline-flex; align-items: center; gap: 5px; font-family: var(--sans); font-size: 12px; color: var(--text-secondary); margin-right: 12px; }
        .doplan .badge { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-family: var(--sans); }
      `}</style>
      <div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 20, fontWeight: 600 }}>SDO schedule planner</div>
          <button className="action small" onClick={toggleTheme}>{theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}</button>
        </div>
        <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16, lineHeight: 1.5 }}>
          Open time picked up on a day already scheduled off pays in addition to your worked credit ("SDO").
          Trade board pickups don't qualify. Everything below is paste or manual entry.
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setNotesOpen((v) => !v)}>
            <div className="h" style={{ marginBottom: 0 }}>Notes</div>
            <button className="action small" onClick={(e) => { e.stopPropagation(); setNotesOpen((v) => !v); }}>{notesOpen ? "Hide" : "Show"}</button>
          </div>
          {notesOpen && (
            <>
              <textarea value={notesText} onChange={(e) => setNotesText(e.target.value)} placeholder="Anything you want to jot down — this is just for you, it doesn't affect anything below." style={{ minHeight: 90, marginTop: 10 }} />
              <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>Reference only — nothing here feeds into any calculation or recommendation.</div>
            </>
          )}
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setPlannerOpen((v) => !v)}>
            <div className="h" style={{ marginBottom: 0 }}>Life planner (reference only)</div>
            <button className="action small" onClick={(e) => { e.stopPropagation(); setPlannerOpen((v) => !v); }}>{plannerOpen ? "Hide" : "Show"}</button>
          </div>
          {plannerOpen && (
            <>
              <div className="hint" style={{ marginTop: 6 }}>Add anything going on in your life this month — appointments, kids' events, whatever. Doesn't affect any recommendation or calculation in this tool, it's just here so you can see your real life alongside your schedule. Add as many entries per day as you want.</div>
              <div style={{ marginTop: 10, maxHeight: 480, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: "4px 10px" }}>
                {Array.from({ length: new Date(year, month + 1, 0).getDate() }, (_, i) => i + 1).map((day) => {
                  const dk = dateKey(year, month, day);
                  const dow = DOW[new Date(year, month, day).getDay()];
                  const activities = getDayActivities(dk);
                  return (
                    <div key={dk} style={{ display: "flex", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
                      <div style={{ width: 56, flexShrink: 0, fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", paddingTop: 6 }}>{dow} {pad2(day)}</div>
                      <div style={{ flex: 1 }}>
                        {activities.map((activity, idx) => (
                          <div key={idx} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                            <input type="text" value={activity} onChange={(e) => updateActivity(dk, idx, e.target.value)} placeholder="Add something for this day…" style={{ flex: 1 }} />
                            {activities.length > 1 && <button className="action small" onClick={() => removeActivity(dk, idx)}>×</button>}
                          </div>
                        ))}
                        <button className="action small" onClick={() => addActivity(dk)}>+ Add activity</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {pendingConfirm && (
          <div style={{ position: "sticky", top: 8, zIndex: 50, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 20, padding: "12px 14px", border: "1px solid var(--amber)", borderRadius: 8, background: "var(--badge-amber-bg)", boxShadow: "0 4px 16px rgba(0,0,0,0.35)" }}>
            <span style={{ fontSize: 13, color: "var(--text-primary)", flex: "1 1 300px" }}>{pendingConfirm.message}</span>
            <button className="action small" onClick={() => resolvePendingConfirm(true)}>Confirm</button>
            <button className="action small" onClick={() => resolvePendingConfirm(false)}>Cancel</button>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 24, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8 }}>
          <button className="action" onClick={savePlannerState}>Save progress</button>
          <button className="action small" onClick={() => loadPlannerState(true)}>Load saved</button>
          <button className="action small" onClick={clearSavedState}>Clear saved data</button>
          <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>{saveStatus || "Nothing saved yet this session."}</span>
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 10 }}>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Hourly pay ($)</div><input type="text" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 90 }} /></div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Bid year</div><input type="number" value={year} onChange={(e) => setYear(parseInt(e.target.value, 10) || year)} style={{ width: 90 }} /></div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Bid month</div><select value={month} onChange={(e) => setMonth(parseInt(e.target.value, 10))}>{MONTH_NAMES.map((m, i) => <option key={i} value={i}>{m}</option>)}</select></div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Baseline schedule credit (h)</div><input type="text" value={baselineCredit} onChange={(e) => setBaselineCredit(e.target.value)} style={{ width: 90 }} placeholder="e.g. 81.49" /></div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Take specific days of the week off</div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            {[["M", 1], ["T", 2], ["W", 3], ["T", 4], ["F", 5], ["S", 6], ["Su", 0]].map(([label, dow]) => (
              <label key={dow} className="chk">
                <input type="checkbox" checked={wantedWeekdays.has(dow)} onChange={() => toggleWantedWeekday(dow)} /> {label}
              </label>
            ))}
            <span style={{ width: 1, height: 16, background: "var(--border)" }} />
            <label className="chk">
              <input type="checkbox" checked={wantedWeekdays.has(0) && wantedWeekdays.has(6)} onChange={toggleWantedWeekends} /> Weekends off
            </label>
          </div>
          <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>Checks off every occurrence of that weekday across both visible months as a wanted day off — combines with the specific dates below.</div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Max consecutive working days you're willing to accept</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="text" value={maxConsecutiveDaysPref} style={{ width: 50 }}
              onChange={(e) => setMaxConsecutiveDaysPref(e.target.value.replace(/[^\d]/g, ""))}
            />
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
              days (contract max is {MAX_CONSECUTIVE_WORK_DAYS}{effectiveMaxConsecutive !== MAX_CONSECUTIVE_WORK_DAYS ? ` — currently using ${effectiveMaxConsecutive}` : ""})
            </span>
          </div>
          <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>Lower this if you personally don't want to work as many days in a row as the contract technically allows — every Add, Swap, and Trade Board recommendation below will respect it. Can't be set above the {MAX_CONSECUTIVE_WORK_DAYS}-day contract limit.</div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Minimum days off between working days (optional)</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="text" value={minRestDaysPref} style={{ width: 50 }} placeholder="off"
              onChange={(e) => setMinRestDaysPref(e.target.value.replace(/[^\d]/g, ""))}
            />
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
              {effectiveMinRestDays > 0 ? `days — currently enforcing a ${effectiveMinRestDays}-day gap` : "days — leave blank to disable"}
            </span>
          </div>
          <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
            If set, no Add, Swap, or Trade Board recommendation will be offered if it would leave less than this many consecutive days off between it and your nearest other working day. For example, with 2 set and you working the 13th, nothing on the 14th or 15th will be recommended — but this is checked fresh against your actual current schedule every time, not fixed to those specific dates, so it updates automatically as your schedule changes.
            {minRestBlockedCount > 0 && ` ${minRestBlockedCount} otherwise-eligible Add${minRestBlockedCount === 1 ? " is" : "s are"} currently hidden by this.`}
          </div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Minimum days off left in the month (optional)</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="text" value={minDaysOffPref} style={{ width: 50 }} placeholder="off"
              onChange={(e) => setMinDaysOffPref(e.target.value.replace(/[^\d]/g, ""))}
            />
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
              {effectiveMinDaysOff > 0 ? `days — currently enforcing a ${effectiveMinDaysOff}-day floor` : "days — leave blank to disable"}
            </span>
          </div>
          <div className="hint" style={{ marginTop: 6, marginBottom: 0 }}>
            Different from the gap rule above — this is a floor on the total count of days off left in the whole bid month, not spacing between pickups. If set, no Add or Trade Board recommendation will be offered if taking it would drop your remaining days off this month below this number. Checked fresh against your actual current days off every time, not a one-time snapshot. Doesn't apply to Swaps, since a Swap itself is what manufactures days off rather than spending them.
            {minDaysOffBlockedCount > 0 && ` ${minDaysOffBlockedCount} otherwise-eligible Add${minDaysOffBlockedCount === 1 ? " is" : "s are"} currently hidden by this.`}
          </div>
        </div>

        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 6 }}>
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Days you want off (comma-separated, e.g. 12,13,20 or 10/2)</div>
            <input type="text" value={wantedText} onChange={(e) => setWantedText(e.target.value)} style={{ width: "100%" }} placeholder="12,13,20" />
          </div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Report no earlier than (military time)</div><input type="text" value={minReport} onChange={(e) => setMinReport(e.target.value)} style={{ width: 90 }} placeholder="09:00" /></div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Arrive no later than (military time)</div><input type="text" value={maxArrive} onChange={(e) => setMaxArrive(e.target.value)} style={{ width: 90 }} placeholder="18:00" /></div>
          <div><div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Your base (time zone)</div><select value={homeBase} onChange={(e) => setHomeBase(e.target.value)}>{BASES.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}</select></div>
        </div>
        <div className="hint" style={{ marginTop: -2 }}>Times are in 24-hour military time, local to the base above — e.g. 3:00 PM is 15:00, 6:00 PM is 18:00. Trade Board pairings that list a different base (only shown when a FLICA CSV export identifies one) are converted to your base's local time before checking these preferences; the Opentime pot, your own schedule, and other Trade Board paste formats don't carry a base and are assumed to already be in your base's local time.</div>
        <label className="chk" style={{ marginBottom: 24, display: "inline-flex" }}>
          <input type="checkbox" checked={applyTimePref} onChange={(e) => setApplyTimePref(e.target.checked)} /> Apply start/end time preference to recommendations
        </label>

        <div className="step">Step 1</div>
        <div className="h">Paste your current schedule</div>
        <textarea rows={6} placeholder={scheduleExample} value={scheduleText} onChange={(e) => setScheduleText(e.target.value)} />
        <div style={{ marginTop: 10, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button className="action" onClick={handleParseSchedule}>Parse schedule</button>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
          <input type="file" accept=".csv,text/csv" onChange={handleScheduleCSV} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
        </div>
        <div className="hint">One line per day: weekday, day number, then pairing code (first day of a trip only) and destination. A day with nothing after the date is a day off. A "VAC", "VAX", "PED", "SICK", "SIC", "SNG", "USIC", "ING", "PUD", "MED", or "BER" day counts as off but can never be worked over ("ING" and "PUD" both code the same as "SICK"). VAC/VAX credit at {VACATION_CREDIT_HOURS}h and PED (Personal Emergency Day) at {PED_CREDIT_HOURS}h each; BER (bereavement) credits {BEREAVEMENT_CREDIT_HOURS}h/day for the first 3 days of each stretch, more only if your Sick Bank covers it (see Sick Bank below); SICK/SIC/SNG/USIC/ING/PUD/MED carry no credit here, since whether your Sick Bank actually covers them isn't knowable from the schedule paste alone. Trailing "Credit" line auto-fills your baseline above. A CSV import parses automatically.</div>

        {scheduleParsed && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
            {scheduleParsed.trips.length} trip{scheduleParsed.trips.length === 1 ? "" : "s"} found, {scheduleParsed.daysOff.size} day{scheduleParsed.daysOff.size === 1 ? "" : "s"} off parsed
            {scheduleParsed.summary.credit != null && <> · Credit line read as {scheduleParsed.summary.credit}h</>}
            {scheduleParsed.vacationDays.size > 0 && (() => {
              let vacCount = 0, pedCount = 0, sickCount = 0, berCount = 0, totalCredit = 0;
              (scheduleParsed.protectedDayCodes || new Map()).forEach((code) => {
                if (code === "VAC" || code === "VAX") { vacCount++; totalCredit += PROTECTED_DAY_CREDIT[code] || 0; }
                else if (code === "PED") { pedCount++; totalCredit += PROTECTED_DAY_CREDIT[code] || 0; }
                else if (code === "BER") berCount++;
                else sickCount++;
              });
              const berCredit = berGuaranteedHours + sickDispersal.results.filter((r) => r.kind === "ber").reduce((s, r) => s + r.coveredHours, 0);
              totalCredit += berCredit;
              const parts = [];
              if (vacCount > 0) parts.push(`${vacCount} VAC/VAX`);
              if (pedCount > 0) parts.push(`${pedCount} PED`);
              if (berCount > 0) parts.push(`${berCount} BER`);
              if (sickCount > 0) parts.push(`${sickCount} Sick/MED`);
              return <> · {parts.join(" + ")} day{scheduleParsed.vacationDays.size === 1 ? "" : "s"} ({totalCredit.toFixed(1)}h credit total, protected from being worked over)</>;
            })()}
            {scheduleParsed.summary.daysOffCount != null && scheduleParsed.summary.daysOffCount !== scheduleParsed.daysOff.size && (
              <span style={{ color: "var(--amber)" }}> · the file's own "Days Off" line says {scheduleParsed.summary.daysOffCount}, which doesn't match — worth a quick check of the source data.</span>
            )}
            {[...(scheduleParsed.protectedDayCodes || new Map()).values()].some((c) => c === "SICK" || c === "SIC" || c === "SNG" || c === "USIC" || c === "ING" || c === "PUD" || c === "MED") && (
              <div style={{ color: "var(--amber-strong)", marginTop: 4 }}>Your schedule has one or more Sick/USIC/MED days on it — since this tool has no way of knowing your Sick Bank balance for the month, the credit hours over those specific days may not be correct. Enter your Sick Start below in Sick Bank to get an actual estimate.</div>
            )}
          </div>
        )}

        {scheduleParsed && droppableTrips.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--amber-strong)", background: "var(--badge-amber-bg)", border: "1px solid var(--border-amber-soft)", borderRadius: 6, padding: "8px 12px", marginBottom: 16 }}>
            FLICA's schedule export only gives a total month credit, never per-trip credit — enter each trip's individual credit hours yourself in "Your trips" below, in <strong>hhmm</strong> format (e.g. type <strong>1636</strong> for 16 hours 36 minutes). Without it, this tool can't auto-adjust your baseline after a swap, and can't warn you before a swap would drop you under the 60-hour floor.
          </div>
        )}

        {droppableTrips.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div className="h">Your trips — flag and check droppability</div>
            <table>
              <thead><tr><th>Pairing</th><th>Dates</th><th>SDO</th><th>Credit hrs</th><th>Premium</th><th>Lock</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {droppableTrips.map((t, i) => (
                  <tr key={i}>
                    <td style={{ color: "var(--text-primary)" }}>{t.pairing}</td>
                    <td>day {t.startDay} +{t.days - 1}d</td>
                    <td><input type="checkbox" checked={t.isSdo} onChange={() => toggleFlag(setSdoFlags, t.key)} /></td>
                    <td>
                      {t.isInjected ? (
                        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>Tracked automatically</span>
                      ) : (
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <input type="text" value={sdoTripCredits.get(t.key) || ""} onChange={(e) => setSdoTripCredit(t.key, e.target.value)} placeholder="e.g. 1636" style={{ width: 70 }} />
                          {t.isSdo && parseCreditToHours(sdoTripCredits.get(t.key)) != null && (
                            <span style={{ fontSize: 12, color: "var(--teal-bright)", fontFamily: "var(--mono)" }}>
                              {formatMoney(parseCreditToHours(sdoTripCredits.get(t.key)) * hourlyRate)} bonus
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td><input type="checkbox" checked={t.isPremium} onChange={() => toggleFlag(setPremiumFlags, t.key)} /></td>
                    <td><input type="checkbox" checked={t.isLocked} onChange={() => toggleFlag(setLockedFlags, t.key)} /></td>
                    <td style={{ color: t.droppable ? "var(--teal-bright)" : "var(--amber-strong)" }}>
                      {t.isLocked ? "Locked — won't be offered for Swap or Trade Board"
                        : t.isSdo ? "Already SDO — dropping forfeits its bonus"
                        : t.gridBlocked ? `Blocked — ${t.blocker.status} on ${t.blocker.key.slice(5)}`
                        : !hasGridData ? "Grid data needed"
                        : "All green — droppable" + (t.wantsOverlap ? " · frees a wanted day" : "")}
                    </td>
                    <td>{t.droppable && <button className="action small" onClick={() => addDaysOff(t.keys)}>Mark these days off</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="hint">SDO = already a Day Off Pay trip on your line — dropping it would give back that bonus. FLICA's schedule export doesn't include per-trip credit, so enter it yourself (e.g. 1636 for 16h36m): for an SDO trip it counts its confirmed bonus in the Actual and Planned totals below; for any trip, entering it also lets a Swap that drops this trip auto-adjust your baseline credit (swap-in credit is always known from the board — only the dropped trips' credit needs entering) and lets the tool check that swap against the 60-hour floor before letting you plan or approve it. Without it, a swap leaves baseline untouched, isn't checked against the floor, and you'll need to adjust it by hand. Premium trips are flagged so swap and trade-board suggestions don't casually give away extra-value trips. Lock a trip you don't want to give up for any reason — it's fully excluded from Swap-drop pairing and Trade Board post candidates, even if it's otherwise droppable.</div>
          </div>
        )}

        <div style={{ marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setSickBankSectionOpen((v) => !v)}>
            <div className="h" style={{ marginBottom: 0 }}>Sick Bank</div>
            <button className="action small" onClick={(e) => { e.stopPropagation(); setSickBankSectionOpen((v) => !v); }}>{sickBankSectionOpen ? "Hide" : "Show"}</button>
          </div>
          {sickBankSectionOpen && (
            <>
              <div className="hint" style={{ marginTop: 6 }}>
                Enter your Sick Start for the month (check ELP) and any days you called out sick (SIC/USIC) or short-term medical (MED) along with the credit hours you were scheduled to work that day — coverage is worked out automatically from here, in date order, draining your Sick Start as it goes: a day is either fully covered (added to credit, paid at your normal rate) or fully not (its scheduled hours subtracted), never partial. Any bereavement (BER) day 4 or day 5 found on your pasted schedule joins this same pool too, in the same date order, but partially — it takes whatever's left in the bank up to {BEREAVEMENT_CREDIT_HOURS}h, and whatever it can't cover is simply left unpaid, never subtracted. The first 3 days of any BER stretch are always credited regardless, no Sick Bank needed. Every day entered here is a protected day off, same as VAC or PED — no Add or swap-in recommendation can ever land on it.
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "10px 0" }}>
                <label style={{ fontSize: 12, color: "var(--text-muted)" }}>Sick Start (from ELP)</label>
                <input type="text" value={sickBankStart} onChange={(e) => setSickBankStart(e.target.value)} placeholder="e.g. 2400 for 24h00m" style={{ width: 120 }} />
                {sickDispersal.startHours != null && (
                  <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: sickDispersal.remaining < 0 ? "var(--amber-strong)" : "var(--text-secondary)" }}>
                    Used {formatHours(sickDispersal.startHours - sickDispersal.remaining)} · Remaining {formatHours(sickDispersal.remaining)}
                  </span>
                )}
              </div>
              {sickDispersal.startHours == null && sickDispersal.results.length > 0 && (
                <div className="hint" style={{ color: "var(--amber-strong)" }}>Enter your Sick Start above to see which of these days are actually covered — nothing below is credited or subtracted until you do.</div>
              )}

              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12, padding: 10, border: "1px solid var(--border)", borderRadius: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>Type</label>
                  <select value={sickDraftType} onChange={(e) => setSickDraftType(e.target.value)}>
                    <option value="SIC">Sick (SIC)</option>
                    <option value="USIC">Sick (USIC)</option>
                    <option value="MED">Short-term medical (MED)</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>Day</label>
                  <input type="number" min="1" max="31" value={sickDraftDay} onChange={(e) => setSickDraftDay(e.target.value)} style={{ width: 60 }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 11, color: "var(--text-muted)" }}>Scheduled credit hrs</label>
                  <input type="text" value={sickDraftHours} onChange={(e) => setSickDraftHours(e.target.value)} placeholder="e.g. 800" style={{ width: 80 }} />
                </div>
                <button className="action" onClick={addSickMedEntry}>Add</button>
              </div>

              {sickDispersal.results.length > 0 && (
                <table style={{ marginTop: 14 }}>
                  <thead><tr><th>Type</th><th>Day</th><th>Hours</th><th>Coverage</th><th>Credit impact</th><th></th></tr></thead>
                  <tbody>
                    {sickDispersal.results.map((r) => {
                      const isBer = r.kind === "ber";
                      const delta = isBer ? r.coveredHours : (r.covered == null ? 0 : (r.covered ? r.neededHours : -r.neededHours));
                      const day = parseInt(r.dateKey.slice(-2), 10);
                      let coverageLabel;
                      if (r.covered == null) coverageLabel = "Pending — enter Sick Start";
                      else if (isBer) coverageLabel = r.coveredHours >= r.neededHours ? "Fully covered" : r.coveredHours > 0 ? `Partially covered (${formatHours(r.coveredHours)} of ${formatHours(r.neededHours)})` : "Not covered — unpaid, not subtracted";
                      else coverageLabel = r.covered ? "Covered by Sick Bank" : "Not covered — subtracted";
                      return (
                        <tr key={r.id}>
                          <td style={{ color: "var(--text-primary)" }}>{isBer ? "BER (from schedule)" : r.entry.type}</td>
                          <td>Day {day}</td>
                          <td>{formatHours(r.neededHours)}</td>
                          <td style={{ fontSize: 12 }}>{coverageLabel}</td>
                          <td style={{ color: delta >= 0 ? "var(--teal-bright)" : "var(--amber-strong)", fontFamily: "var(--mono)" }}>{r.covered == null ? "—" : formatSignedHours(delta)}</td>
                          <td>{!isBer && <button className="action small" onClick={() => removeSickMedEntry(r.entry.id)}>Remove</button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8 }}>
                Total credit impact: <span style={{ fontFamily: "var(--mono)", color: sickAndBerCreditDelta >= 0 ? "var(--teal-bright)" : "var(--amber-strong)" }}>{formatSignedHours(sickAndBerCreditDelta)}</span>
                {" "}({formatMoney(sickAndBerCreditDelta * hourlyRate)}) — {formatHours(berGuaranteedHours)} guaranteed BER, {formatSignedHours(sickDispersal.creditDelta)} from Sick Bank dispersal — folded into your Actual total below.
              </div>
            </>
          )}
        </div>

        {originalCalendarText && (
          <div style={{ marginBottom: 24 }}>
            <div className="h">Your schedule — original, planned, and updated</div>
            <div style={{ display: "flex", gap: 14, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
              <label className="chk"><input type="checkbox" checked={calVisible.original} onChange={() => toggleCalVisible("original")} /> Original</label>
              <label className="chk"><input type="checkbox" checked={calVisible.planned} onChange={() => toggleCalVisible("planned")} /> Planned</label>
              <label className="chk"><input type="checkbox" checked={calVisible.updated} onChange={() => toggleCalVisible("updated")} /> Updated</label>
              <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--sans)" }}>RTB = Return to Base</span>
            </div>
            {(() => {
              const visibleCount = [calVisible.original, calVisible.planned, calVisible.updated].filter(Boolean).length;
              const calFontSize = visibleCount <= 1 ? 14 : visibleCount === 2 ? 13 : 12;
              const calBasis = visibleCount <= 1 ? "100%" : visibleCount === 2 ? "360px" : "260px";
              return visibleCount === 0 ? (
                <div className="hint" style={{ marginTop: 0 }}>All three panels are hidden — check a box above to show one.</div>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    {calVisible.original && (
                      <div style={{ flex: `1 1 ${calBasis}`, minWidth: 220 }}>
                        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>As imported</div>
                        <pre style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: 10, fontFamily: "var(--mono)", fontSize: calFontSize, color: "var(--text-secondary)", whiteSpace: "pre-wrap", margin: 0 }}>{originalCalendarText}</pre>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>Total credit hours: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{scheduleParsed.summary.credit != null ? scheduleParsed.summary.credit.toFixed(2) : "—"}</span></div>
                      </div>
                    )}
                    {calVisible.planned && (
                      <div style={{ flex: `1 1 ${calBasis}`, minWidth: 220 }}>
                        <div style={{ fontSize: 12, color: "var(--amber)", marginBottom: 6 }}>Planned — with top-priority picks applied</div>
                        <pre style={{ background: "var(--surface)", border: "1px solid var(--border-amber-soft)", borderRadius: 6, padding: 10, fontFamily: "var(--mono)", fontSize: calFontSize, color: "var(--text-secondary)", whiteSpace: "pre-wrap", margin: 0 }}>{plannedCalendarText}</pre>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--amber)", marginTop: 8 }}>Total credit hours: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{workedHours.toFixed(2)}</span></div>
                      </div>
                    )}
                    {calVisible.updated && (
                      <div style={{ flex: `1 1 ${calBasis}`, minWidth: 220 }}>
                        <div style={{ fontSize: 12, color: "var(--teal-bright)", marginBottom: 6 }}>Updated — reflects approved changes</div>
                        <pre style={{ background: "var(--surface)", border: "1px solid var(--border-teal-soft)", borderRadius: 6, padding: 10, fontFamily: "var(--mono)", fontSize: calFontSize, color: "var(--text-secondary)", whiteSpace: "pre-wrap", margin: 0 }}>{updatedCalendarText}</pre>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--teal-bright)", marginTop: 8 }}>Total credit hours: <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{baselineHours.toFixed(2)}</span></div>
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
            <div className="hint">The middle panel is a preview only, nothing here is committed — it layers whichever Planned Adds and Swaps currently win the priority order (from "Your plan" below) on top of the updated schedule, and shifts automatically as you reorder or check/uncheck Planned boxes. The right panel only moves when you check "Approved." The final day of any Add or swap-in shows RTB, since the Opentime pot's layover string never lists the actual return station. Block figures may be incorrect after any change — they're carried over from your original import, since FLICA doesn't expose per-trip block time for your own dropped trips, so it can't be recalculated here.</div>
          </div>
        )}

        <div className="step">Step 2</div>
        <div className="h">Paste the Reserve Grid</div>
        <textarea rows={4} placeholder={gridExample} value={gridText} onChange={(e) => setGridText(e.target.value)} />
        <div style={{ marginTop: 10, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button className="action" onClick={handleParseGrid}>Parse grid</button>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
          <input type="file" accept=".csv,text/csv" onChange={handleGridCSV} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
          {gridParsed?.error && <span style={{ fontSize: 13, color: "var(--amber-strong)" }}>{gridParsed.error}</span>}
        </div>
        <div className="hint" style={{ marginBottom: 12 }}>Needs Date, Net Reserves, and Min Required (Buffer) columns. Green = safe to drop, black/red = blocked. A CSV import parses automatically.</div>
        {gridParsed && gridParsed.usedColumns && (
          <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: -8, marginBottom: 16 }}>
            Using <span style={{ color: "var(--teal-bright)" }}>{gridParsed.usedColumns.join(", ")}</span> — {gridParsed.grid.size} day{gridParsed.grid.size === 1 ? "" : "s"} read.
            {gridParsed.ignoredColumns.length > 0 && <> Ignored: {gridParsed.ignoredColumns.join(", ")}.</>}
          </div>
        )}

        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, marginTop: 4 }}>Or enter days one at a time</div>
        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 8 }}>
          <div><div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>Date</div><input type="text" value={gridDateInput} onChange={(e) => setGridDateInput(e.target.value)} style={{ width: 80 }} placeholder="09SEP" /></div>
          <div><div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>Net reserves</div><input type="text" value={gridNetInput} onChange={(e) => setGridNetInput(e.target.value)} style={{ width: 90 }} placeholder="38" /></div>
          <div><div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 4 }}>Min required (buffer)</div><input type="text" value={gridMinInput} onChange={(e) => setGridMinInput(e.target.value)} style={{ width: 110 }} placeholder="30" /></div>
          <button className="action small" onClick={handleAddGridRow}>Add row</button>
        </div>
        {gridRowError && <div style={{ fontSize: 12, color: "var(--amber-strong)", marginBottom: 8 }}>{gridRowError}</div>}

        {manualGridRows.length > 0 && (
          <table style={{ marginBottom: 12 }}>
            <thead><tr><th>Date</th><th>Net reserves</th><th>Min required</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {manualGridRows.map((r) => {
                const status = r.net > r.min ? "green" : r.net === r.min ? "black" : "red";
                const color = status === "green" ? "var(--teal-bright)" : status === "black" ? "var(--text-muted)" : "var(--amber-strong)";
                return (
                  <tr key={r.id}>
                    <td style={{ color: "var(--text-primary)" }}>{r.dateTok}</td>
                    <td>{r.net}</td>
                    <td>{r.min}</td>
                    <td style={{ color }}>{status}</td>
                    <td><button className="action small" onClick={() => removeGridRow(r.id)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="hint">Manually entered days are combined with anything pasted above — a manual entry for the same date takes priority.</div>

        <div className="h">Your scheduled days off</div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 8 }}>
          <MonthCalendar year={year} month={month} daysOff={daysOff} wantedOff={wantedOff} onToggle={toggleDayOff} />
          <MonthCalendar year={nextMonthYear} month={nextMonth} daysOff={daysOff} wantedOff={wantedOff} onToggle={toggleDayOff} />
        </div>
        <div className="hint">Teal = currently off. Amber outline = a day you want off (from the field above) — thicker border means both. {daysOffMarked} day{daysOffMarked === 1 ? "" : "s"} currently marked off.</div>

        <div className="step">Step 3</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="h" style={{ marginBottom: 0 }}>Paste the Opentime pot (Adds — eligible for Day Off Pay / SDO)</div>
          <select value={openBase} onChange={(e) => setOpenBase(e.target.value)} style={{ fontSize: 12 }}>{BASES.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}</select>
        </div>
        <textarea rows={5} placeholder={boardExample} value={openText} onChange={(e) => setOpenText(e.target.value)} />
        <div style={{ marginTop: 10, marginBottom: 20, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button className="action" onClick={handleParseOpen}>Parse Opentime pot</button>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
          <input type="file" accept=".csv,text/csv" onChange={handleOpenCSV} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
          {openParsed.error && <span style={{ fontSize: 13, color: "var(--amber-strong)" }}>{openParsed.error}</span>}
        </div>

        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Or upload a screenshot of the Opentime pot</div>
        <div
          onPaste={handleImagePaste}
          style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 14, marginBottom: 10 }}
        >
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input type="file" accept="image/*" onChange={handleImageSelect} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
            <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or click here and paste (Ctrl/Cmd+V) a copied screenshot</span>
          </div>
          {imgPreview && (
            <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <img src={imgPreview} alt="Open time screenshot preview" style={{ maxWidth: 220, maxHeight: 120, borderRadius: 6, border: "1px solid var(--border)" }} />
              <button className="action small" onClick={handleExtractOpenTime} disabled={imgLoading}>
                {imgLoading ? "Reading…" : "Extract table"}
              </button>
            </div>
          )}
          {imgError && <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 8 }}>{imgError}</div>}
        </div>
        <div className="hint">
          Extraction happens in one pass with a fixed output budget, so a very long board may only bring in the
          first several dozen rows — upload again for the rest, or crop the screenshot into sections first. Review
          every field below before relying on it; OCR on small print can misread digits.
        </div>

        {imageRows.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div className="h">Extracted from screenshot — edit anything that looks wrong</div>
            <table>
              <thead>
                <tr><th>Pairing</th><th>Dates</th><th>Days</th><th>Report</th><th>Arrive</th><th>Credit</th><th>Layover</th><th>TB</th><th></th></tr>
              </thead>
              <tbody>
                {imageRows.map((r) => (
                  <tr key={r.id}>
                    <td><input type="text" value={r.pairing} onChange={(e) => updateImageRow(r.id, "pairing", e.target.value)} style={{ width: 80 }} /></td>
                    <td><input type="text" value={r.dateTok} onChange={(e) => updateImageRow(r.id, "dateTok", e.target.value)} style={{ width: 70 }} placeholder="09SEP" /></td>
                    <td><input type="text" value={r.days} onChange={(e) => updateImageRow(r.id, "days", e.target.value)} style={{ width: 40 }} /></td>
                    <td><input type="text" value={r.report} onChange={(e) => updateImageRow(r.id, "report", e.target.value)} style={{ width: 60 }} placeholder="10:02" /></td>
                    <td><input type="text" value={r.arrive} onChange={(e) => updateImageRow(r.id, "arrive", e.target.value)} style={{ width: 60 }} placeholder="15:22" /></td>
                    <td><input type="text" value={r.creditRaw} onChange={(e) => updateImageRow(r.id, "creditRaw", e.target.value)} style={{ width: 60 }} placeholder="1636" /></td>
                    <td><input type="text" value={r.layover} onChange={(e) => updateImageRow(r.id, "layover", e.target.value)} style={{ width: 110 }} /></td>
                    <td><input type="checkbox" checked={r.tb} onChange={(e) => updateImageRow(r.id, "tb", e.target.checked)} /></td>
                    <td><button className="action small" onClick={() => removeImageRow(r.id)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 10 }}><button className="action small" onClick={addBlankImageRow}>Add blank row</button></div>
            <div className="hint">These rows feed the same Add rankings and recommendations below as the pasted table — a checked TB box excludes that row from SDO just like the auto-detected tag.</div>
          </div>
        )}

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Other bases' Opentime pots (optional)</div>
          {extraBoards.map((board, idx) => (
            <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
              <button
                onClick={() => toggleExtraBoardExpanded(idx)}
                style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, color: "var(--text-secondary)", fontFamily: "var(--sans)", fontSize: 13 }}
              >
                <span style={{ transform: board.expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", color: "var(--text-faint)" }}>▶</span>
                <input
                  type="text"
                  value={board.label}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handleExtraLabelChange(idx, e.target.value)}
                  style={{ width: 100 }}
                />
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {board.parsed.trips.length + board.imageRows.length > 0 ? `${board.parsed.trips.length + board.imageRows.length} trip(s) loaded` : "empty"}
                </span>
              </button>
              {board.expanded && (
                <div style={{ padding: "0 12px 14px 12px" }}>
                  <textarea rows={4} placeholder={boardExample} value={board.text} onChange={(e) => updateExtraBoard(idx, { text: e.target.value })} />
                  <div style={{ marginTop: 10, marginBottom: 8, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="action small" onClick={() => handleExtraParseText(idx)}>Parse Opentime pot</button>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
                    <input type="file" accept=".csv,text/csv" onChange={(e) => handleExtraCSV(idx, e)} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
                    {board.parsed.error && <span style={{ fontSize: 13, color: "var(--amber-strong)" }}>{board.parsed.error}</span>}
                  </div>

                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Or upload a screenshot</div>
                  <div onPaste={(e) => handleExtraImagePaste(idx, e)} style={{ border: "1px dashed var(--border)", borderRadius: 8, padding: 14, marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <input type="file" accept="image/*" onChange={(e) => handleExtraImageSelect(idx, e)} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
                      <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or click here and paste (Ctrl/Cmd+V) a copied screenshot</span>
                    </div>
                    {board.imgPreview && (
                      <div style={{ marginTop: 10, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                        <img src={board.imgPreview} alt="Open time screenshot preview" style={{ maxWidth: 220, maxHeight: 120, borderRadius: 6, border: "1px solid var(--border)" }} />
                        <button className="action small" onClick={() => handleExtraExtractOpenTime(idx)} disabled={board.imgLoading}>
                          {board.imgLoading ? "Reading…" : "Extract table"}
                        </button>
                      </div>
                    )}
                    {board.imgError && <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 8 }}>{board.imgError}</div>}
                  </div>

                  {board.imageRows.length > 0 && (
                    <div>
                      <div className="h">Extracted from screenshot — edit anything that looks wrong</div>
                      <table>
                        <thead><tr><th>Pairing</th><th>Dates</th><th>Days</th><th>Report</th><th>Arrive</th><th>Credit</th><th>Layover</th><th>TB</th><th></th></tr></thead>
                        <tbody>
                          {board.imageRows.map((r) => (
                            <tr key={r.id}>
                              <td><input type="text" value={r.pairing} onChange={(e) => updateExtraImageRow(idx, r.id, "pairing", e.target.value)} style={{ width: 80 }} /></td>
                              <td><input type="text" value={r.dateTok} onChange={(e) => updateExtraImageRow(idx, r.id, "dateTok", e.target.value)} style={{ width: 70 }} placeholder="09SEP" /></td>
                              <td><input type="text" value={r.days} onChange={(e) => updateExtraImageRow(idx, r.id, "days", e.target.value)} style={{ width: 40 }} /></td>
                              <td><input type="text" value={r.report} onChange={(e) => updateExtraImageRow(idx, r.id, "report", e.target.value)} style={{ width: 60 }} placeholder="10:02" /></td>
                              <td><input type="text" value={r.arrive} onChange={(e) => updateExtraImageRow(idx, r.id, "arrive", e.target.value)} style={{ width: 60 }} placeholder="15:22" /></td>
                              <td><input type="text" value={r.creditRaw} onChange={(e) => updateExtraImageRow(idx, r.id, "creditRaw", e.target.value)} style={{ width: 60 }} placeholder="1636" /></td>
                              <td><input type="text" value={r.layover} onChange={(e) => updateExtraImageRow(idx, r.id, "layover", e.target.value)} style={{ width: 110 }} /></td>
                              <td><input type="checkbox" checked={r.tb} onChange={(e) => updateExtraImageRow(idx, r.id, "tb", e.target.checked)} /></td>
                              <td><button className="action small" onClick={() => removeExtraImageRow(idx, r.id)}>Remove</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: 10 }}><button className="action small" onClick={() => addBlankExtraImageRow(idx)}>Add blank row</button></div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div className="hint">Each of these works exactly like the main Opentime pot above and feeds the same recommendations — use them for other bases you can pick up from. Rename the label (e.g. to the actual base code) to keep track of which is which.</div>
        </div>

        <div style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setOpenPotViewerOpen((v) => !v)}>
            <div className="h" style={{ marginBottom: 0 }}>View Opentime pot ({allOpenTrips.length})</div>
            <button className="action small" onClick={(e) => { e.stopPropagation(); setOpenPotViewerOpen((v) => !v); }}>{openPotViewerOpen ? "Hide" : "Show"}</button>
          </div>
          {openPotViewerOpen && (
            allOpenTrips.length > 0 ? (
              <table style={{ marginTop: 10 }}>
                <thead><tr><th>Pairing</th><th>Dates</th><th>Credit</th><th>Layover</th><th>SDO eligible</th></tr></thead>
                <tbody>
                  {enrichedOpen.slice().sort((a, b) => (a.start && b.start ? new Date(a.start.year, a.start.month, a.start.day) - new Date(b.start.year, b.start.month, b.start.day) : 0)).map((t) => (
                    <tr key={t.id}>
                      <td style={{ color: "var(--text-primary)" }}>{t.pairing}{t.autoTB && <span className="badge" style={{ background: "var(--badge-amber-bg)", color: "var(--amber)", marginLeft: 4 }}>TB</span>}{t.fromDrop && <span className="badge" style={{ background: "var(--border-teal-soft)", color: "var(--teal-bright)", marginLeft: 4 }}>DROPPED</span>}</td>
                      <td>{t.dateTok} +{t.days - 1}d</td>
                      <td>{formatHours(t.creditHours)}</td>
                      <td style={{ fontFamily: "var(--sans)", color: "var(--text-muted)" }}>{t.layover}</td>
                      <td style={{ fontSize: 11, color: t.eligible ? "var(--teal-bright)" : "var(--text-faint)" }}>{t.eligible ? "Yes — fully covers a day off" : t.autoTB ? "Never (TB)" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="hint" style={{ marginTop: 8 }}>Nothing parsed yet — paste or import the Opentime pot above.</div>
            )
          )}
        </div>

        <div className="step">Step 4 (optional)</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div className="h" style={{ marginBottom: 0 }}>Paste Trade Board pairings (not eligible for SDO)</div>
          <select value={tradeBase} onChange={(e) => setTradeBase(e.target.value)} style={{ fontSize: 12 }}>{BASES.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}</select>
        </div>
        <textarea rows={4} placeholder={boardExample} value={tradeText} onChange={(e) => setTradeText(e.target.value)} />
        <div style={{ marginTop: 10, marginBottom: 8, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <button className="action" onClick={handleParseTrade}>Parse trade board</button>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
          <input type="file" accept=".csv,text/csv" onChange={handleTradeCSV} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
          {tradeParsed.error && <span style={{ fontSize: 13, color: "var(--amber-strong)" }}>{tradeParsed.error}</span>}
        </div>
        <div className="hint">A "TB" tag pasted into the Opentime pot box above is auto-detected and excluded from SDO too, but keep them separate here to avoid confusion. A CSV exported directly from FLICA's Trade Board page (the jammed-together multi-line format) is detected automatically and read correctly — no reformatting needed. The base dropdown tags every pairing from this paste with that base's time zone for the report/arrive preference checks — a CSV export's own per-pairing base (when it has one) always wins over this.</div>

        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Other bases' Trade Board pairings (optional)</div>
          {extraTradeBoards.map((board, idx) => (
            <div key={idx} style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
              <button
                onClick={() => toggleExtraTradeBoardExpanded(idx)}
                style={{ width: "100%", textAlign: "left", background: "transparent", border: "none", padding: "10px 12px", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, color: "var(--text-secondary)", fontFamily: "var(--sans)", fontSize: 13 }}
              >
                <span style={{ transform: board.expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s", display: "inline-block", color: "var(--text-faint)" }}>▶</span>
                <span>{board.label}</span>
                <select
                  value={board.base}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => handleExtraTradeBaseChange(idx, e.target.value)}
                  style={{ fontSize: 12 }}
                >
                  {BASES.map((b) => <option key={b.code} value={b.code}>{b.label}</option>)}
                </select>
                <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                  {board.parsed.trips.length > 0 ? `${board.parsed.trips.length} trip(s) loaded` : "empty"}
                </span>
              </button>
              {board.expanded && (
                <div style={{ padding: "0 12px 14px 12px" }}>
                  <textarea rows={4} placeholder={boardExample} value={board.text} onChange={(e) => updateExtraTradeBoard(idx, { text: e.target.value })} />
                  <div style={{ marginTop: 10, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
                    <button className="action small" onClick={() => handleExtraTradeParseText(idx)}>Parse trade board</button>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>or import a CSV:</span>
                    <input type="file" accept=".csv,text/csv" onChange={(e) => handleExtraTradeCSV(idx, e)} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-secondary)" }} />
                    {board.parsed.error && <span style={{ fontSize: 13, color: "var(--amber-strong)" }}>{board.parsed.error}</span>}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {autoFlaggedTB.length > 0 && <div className="hint">{autoFlaggedTB.length} row{autoFlaggedTB.length === 1 ? "" : "s"} in the Opentime pot paste had a "TB" tag and {autoFlaggedTB.length === 1 ? "was" : "were"} auto-excluded.</div>}
        {maxStreakBlockedCount > 0 && <div className="hint">{maxStreakBlockedCount} otherwise-eligible Add{maxStreakBlockedCount === 1 ? "" : "s"} hidden — picking {maxStreakBlockedCount === 1 ? "it" : "them"} up would put you on more than {effectiveMaxConsecutive} consecutive working days.</div>}
        {restBlockedCount > 0 && <div className="hint">{restBlockedCount} otherwise-eligible Add{restBlockedCount === 1 ? "" : "s"} hidden — {restBlockedCount === 1 ? "it doesn't" : "they don't"} leave at least {MIN_REST_HOURS} hours of rest against something already on your schedule. This check only works where a report/arrival time is known (Opentime pot and Trade Board trips) — it can't verify rest against your originally-imported schedule days, since that import has no clock times at all.</div>}

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20, marginBottom: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 16 }}>Recommendations</div>
        </div>

        {eligibleSorted.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setAddsReadySectionOpen((v) => !v)}>
              <div className="h" style={{ marginBottom: 0 }}>Adds — ready now, ranked by pay per day off used</div>
              <button className="action small" onClick={(e) => { e.stopPropagation(); setAddsReadySectionOpen((v) => !v); }}>{addsReadySectionOpen ? "Hide" : "Show"}</button>
            </div>
            {addsReadySectionOpen && <table style={{ marginBottom: 24 }}>
              <thead><tr><th>Planned</th><th>Approved</th><th>Denied</th><th>Pairing</th><th>Dates</th><th>Credit</th><th>Est. pay</th><th>$ / day off</th><th></th></tr></thead>
              <tbody>
                {eligibleSorted.map((t) => {
                  const isSel = selected.has(t.id);
                  const isAcc = acceptedAdds.has(t.id);
                  const accBlocked = acceptedConflicts(t);
                  const swapConflict = getPlannedSwapConflict(t);
                  return (
                    <tr key={t.id}>
                      <td><input type="checkbox" checked={isSel} onChange={() => toggleSelect(t)} /></td>
                      <td><input type="checkbox" checked={isAcc} disabled={accBlocked} onChange={() => toggleAcceptedAdd(t)} /></td>
                      <td><input type="checkbox" checked={false} onChange={() => toggleDeniedAdd(t)} /></td>
                      <td style={{ color: "var(--text-primary)" }}>
                        {t.pairing}
                        {swapConflict && (
                          <div style={{ fontSize: 10, color: "var(--amber-strong)", fontFamily: "var(--sans)", fontWeight: 400, marginTop: 2 }}>
                            Not possible right now — {swapConflict.label} would take over this day if approved.
                          </div>
                        )}
                      </td>
                      <td>{t.dateTok} +{t.days - 1}d</td>
                      <td>{formatHours(t.creditHours)}</td>
                      <td style={{ color: "var(--teal-bright)" }}>{t.pay != null ? formatMoney(t.pay) : "—"}</td>
                      <td>{t.perDay != null ? formatMoney(t.perDay) : "—"}</td>
                      <td>{t.usesWanted && <span className="badge" style={{ background: "var(--badge-amber-bg)", color: "var(--amber)" }}>wanted day</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
          </>
        )}

        {deniedAddIds.size > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Denied Adds (hidden from recommendations)</div>
            {[...deniedAddIds].map((id) => {
              const t = enrichedOpen.find((x) => x.id === id);
              return (
                <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-faint)", marginBottom: 4 }}>
                  <span>{t ? `${t.pairing} (${t.dateTok})` : id}</span>
                  <button className="action small" onClick={() => { if (t) toggleDeniedAdd(t); else setDeniedAddIds((prev) => { const n = new Set(prev); n.delete(id); return n; }); }}>Restore</button>
                </div>
              );
            })}
          </div>
        )}

        {nearMiss.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setAddsNearMissSectionOpen((v) => !v)}>
              <div className="h" style={{ marginBottom: 0 }}>Adds — close, needs more days off marked</div>
              <button className="action small" onClick={(e) => { e.stopPropagation(); setAddsNearMissSectionOpen((v) => !v); }}>{addsNearMissSectionOpen ? "Hide" : "Show"}</button>
            </div>
            {addsNearMissSectionOpen && <table style={{ marginBottom: 24 }}>
              <thead><tr><th>Pairing</th><th>Dates</th><th>Credit</th><th>Needs</th><th></th></tr></thead>
              <tbody>
                {nearMiss.map((t) => {
                  const swapConflict = getPlannedSwapConflict(t);
                  // A missing day already carrying a live trip can't just be marked off -- that
                  // trip needs to actually be dropped (see Swaps) first, or this button would
                  // silently claim the day is free while the real schedule still has it occupied.
                  const missingOccupied = t.missing.filter((k) => occupiedDateKeys.has(k));
                  const allMissingBlocked = missingOccupied.length === t.missing.length;
                  return (
                    <tr key={t.id}>
                      <td style={{ color: "var(--text-primary)" }}>
                        {t.pairing}
                        {swapConflict && (
                          <div style={{ fontSize: 10, color: "var(--amber-strong)", fontFamily: "var(--sans)", fontWeight: 400, marginTop: 2 }}>
                            Not possible right now — {swapConflict.label} would take over this day if approved.
                          </div>
                        )}
                        {missingOccupied.length > 0 && (
                          <div style={{ fontSize: 10, color: "var(--amber-strong)", fontFamily: "var(--sans)", fontWeight: 400, marginTop: 2 }}>
                            {missingOccupied.length} of the missing day{missingOccupied.length === 1 ? "" : "s"} already {missingOccupied.length === 1 ? "has" : "have"} a trip on it — drop it via a Swap first, this button can't override that.
                          </div>
                        )}
                      </td>
                      <td>{t.dateTok} +{t.days - 1}d</td>
                      <td>{formatHours(t.creditHours)}</td>
                      <td style={{ color: "var(--amber-strong)" }}>{t.missing.length} more day{t.missing.length === 1 ? "" : "s"} off</td>
                      <td><button className="action small" disabled={allMissingBlocked} onClick={() => addDaysOff(t.missing)}>Mark those days off</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setSwapsSectionOpen((v) => !v)}>
          <div className="h" style={{ marginBottom: 0 }}>Swaps — every way to manufacture days off, grouped by what you'd swap into</div>
          <button className="action small" onClick={(e) => { e.stopPropagation(); setSwapsSectionOpen((v) => !v); }}>{swapsSectionOpen ? "Hide" : "Show"}</button>
        </div>
        {swapsSectionOpen && ((swapInGroups.length > 0 || multiSwapInOptions.length > 0) ? (
          <>
            {swapInGroups.map((group, gi) => {
              const groupKey = group.swapIn.id;
              const groupCollapsed = !expandedSwapGroups.has(groupKey);
              return (
              <div key={gi} style={{ marginBottom: 18 }}>
                <div
                  style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", gap: 8 }}
                  onClick={() => toggleSwapGroupCollapsed(groupKey)}
                >
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                    Swap into <span style={{ color: "var(--text-primary)" }}>{group.swapIn.pairing}</span> ({group.swapIn.dateTok} +{group.swapIn.days - 1}d, {formatHours(group.swapIn.creditHours)} credit) — {group.rows.length} way{group.rows.length === 1 ? "" : "s"} to get there — most potential days freed: {group.rows[0].freedCount}
                  </div>
                  <button className="action small" onClick={(e) => { e.stopPropagation(); toggleSwapGroupCollapsed(groupKey); }}>{groupCollapsed ? "Show" : "Hide"}</button>
                </div>
                {!groupCollapsed && group.rows.map((row) => {
                  const { pair: p, swapIn, rowKey, freedKeys, unlockedAdds } = row;
                  const swapChecked = selectedSwaps.has(rowKey);
                  const swapAccepted = acceptedSwaps.has(rowKey);
                  const addsShown = showAddsFor.has(rowKey);
                  const floorProjection = projectedHoursIfSwapPlanned(p, [swapIn]);
                  const approveWouldViolateFloor = !swapAccepted && floorProjection != null && floorProjection < 60;
                  return (
                    <div key={rowKey} style={{ border: swapAccepted ? "1px solid var(--teal-bright)" : swapChecked ? "1px solid var(--teal)" : "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 8, marginLeft: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={swapChecked} onChange={() => toggleSwap(rowKey, unlockedAdds.map((t) => t.id))} /> Planned
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: approveWouldViolateFloor ? "not-allowed" : "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={swapAccepted} disabled={approveWouldViolateFloor} onChange={() => toggleAcceptedSwap(p, rowKey, swapIn)} /> Approved in FLICA
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={deniedSwapKeys.has(rowKey)} onChange={() => toggleDeniedSwap(p, rowKey, swapIn)} /> Denied
                          </label>
                          <span style={{ color: "var(--text-primary)", fontFamily: "var(--mono)", fontSize: 13 }}>
                            Drop {p.a.pairing}{p.a.isPremium && <span className="badge" style={{ background: "var(--badge-red-bg)", color: "var(--amber-strong)", marginLeft: 4 }}>premium</span>}
                            {" + "}
                            {p.b.pairing}{p.b.isPremium && <span className="badge" style={{ background: "var(--badge-red-bg)", color: "var(--amber-strong)", marginLeft: 4 }}>premium</span>}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: p.wantsOverlap ? "var(--amber)" : "var(--text-muted)", fontFamily: "var(--sans)" }}>
                          Frees {freedKeys.length} day{freedKeys.length === 1 ? "" : "s"}{p.wantsOverlap ? " · includes a wanted day" : ""}
                        </div>
                      </div>
                      {approveWouldViolateFloor && (() => {
                        const shortfall = 60 - floorProjection;
                        const floorFixes = getFloorFixSuggestions(shortfall, [p.a.key, p.b.key]);
                        return (
                          <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 8 }}>
                            Can't approve this swap yet — it would take your worked total to {floorProjection.toFixed(2)}h, under the 60h floor. Still fine to mark Planned and compare against other ways to get there.
                            {floorFixes.length > 0 ? (
                              <div style={{ marginTop: 4 }}>
                                Ways to clear the floor first:
                                <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                                  {floorFixes.map((fx, i) => (
                                    <li key={i}>{fx.label} — brings you to {(floorProjection + fx.credit).toFixed(2)}h</li>
                                  ))}
                                </ul>
                                {floorFixes.some((fx) => fx.kind === "trade") && (
                                  <div style={{ marginTop: 4, fontStyle: "italic" }}>
                                    Trade Board listings are usually a straight drop, not a swap-for-swap request — check what this specific posting actually says on FLICA before counting on it. If they just want it gone, it's really a normal (non-SDO) pickup, not a trade. If they do want something specific back, that's between you and them to work out on FLICA — this tool can't confirm what they'll accept.
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div style={{ marginTop: 4, fontStyle: "italic" }}>No current Add, Trade Board pickup, or Trade would clear the floor for this swap yet.</div>
                            )}
                          </div>
                        );
                      })()}
                      <button className="action small" style={{ marginTop: 8 }} onClick={() => toggleShowAdds(rowKey)}>
                        {addsShown ? "Hide" : "Show"} possible adds ({unlockedAdds.length})
                      </button>
                      {addsShown && (
                        unlockedAdds.length > 0 ? (
                          <div style={{ marginTop: 8 }}>
                            {!swapChecked && <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>Check "Planned" above to mark these as planned too.</div>}
                            {swapChecked && !swapAccepted && <div style={{ fontSize: 11, color: "var(--text-faint)", marginBottom: 6 }}>These days aren't actually free until the swap above is checked "Approved in FLICA" — approving one of these first would land it on a day that isn't really off yet.</div>}
                            <table>
                              <thead><tr><th>Planned</th><th>Approved</th><th>Denied</th><th>Pairing</th><th>Dates</th><th>Credit</th><th>Est. pay</th><th>$ / day off</th></tr></thead>
                              <tbody>
                                {unlockedAdds.slice().sort((a, b) => (b.perDay || 0) - (a.perDay || 0)).map((t) => {
                                  const isSel = selected.has(t.id);
                                  const isAcc = acceptedAdds.has(t.id);
                                  // Requires the swap itself to be truly Approved, not merely Planned -- these
                                  // days aren't actually free on the real schedule until the swap that frees
                                  // them has gone through for real. Approving one of these against a swap
                                  // that's only Planned would commit an Add onto a day that isn't really off,
                                  // silently double-booking it and corrupting every downstream consecutive-day
                                  // and 60-hour-floor check. This was a real bug once.
                                  const accBlocked = !swapAccepted || acceptedConflicts(t);
                                  // eligibleSorted trips are already-known-time pot/board candidates the schedule
                                  // itself has no idea about yet (they're not live), so violatesRest can't see a
                                  // conflict against them -- this catches it separately so it can be flagged
                                  // instead of two independently-clean-looking Adds silently not actually fitting
                                  // together once both are accepted in FLICA.
                                  const restConflict = findAdjacentRestConflict(t, [...eligibleSorted, ...unlockedAdds]);
                                  return (
                                    <tr key={t.id} style={{ opacity: swapChecked ? 1 : 0.5 }}>
                                      <td><input type="checkbox" checked={isSel} disabled={!swapChecked} onChange={() => toggleSelect(t)} /></td>
                                      <td><input type="checkbox" checked={isAcc} disabled={accBlocked} onChange={() => toggleAcceptedAdd(t)} /></td>
                                      <td><input type="checkbox" checked={false} onChange={() => toggleDeniedAdd(t)} /></td>
                                      <td style={{ color: "var(--text-primary)" }}>
                                        {t.pairing}
                                        {restConflict && (
                                          <div style={{ fontSize: 10, color: "var(--amber-strong)", fontFamily: "var(--sans)", fontWeight: 400, marginTop: 2 }}>
                                            Wouldn't currently fit in FLICA — not enough rest against {restConflict.pairing} ({restConflict.dateTok}), also shown as available.
                                          </div>
                                        )}
                                      </td>
                                      <td>{t.dateTok} +{t.days - 1}d</td>
                                      <td>{formatHours(t.creditHours)}</td>
                                      <td style={{ color: "var(--teal-bright)" }}>{t.pay != null ? formatMoney(t.pay) : "—"}</td>
                                      <td>{t.perDay != null ? formatMoney(t.perDay) : "—"}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, color: "var(--text-faint)", fontFamily: "var(--sans)", marginTop: 6 }}>Nothing on the current Opentime pot fits fully inside these freed days yet.</div>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
              );
            })}
            {multiSwapInOptions.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-muted)", marginBottom: 8 }}>
                  No single pickup covers these — combining two trips together as the swap-in
                </div>
                {multiSwapInOptions.map((row) => {
                  const { pair: p, swapIns, rowKey, freedKeys } = row;
                  const swapChecked = selectedSwaps.has(rowKey);
                  const swapAccepted = acceptedSwaps.has(rowKey);
                  const floorProjection = projectedHoursIfSwapPlanned(p, swapIns);
                  const approveWouldViolateFloor = !swapAccepted && floorProjection != null && floorProjection < 60;
                  return (
                    <div key={rowKey} style={{ border: swapAccepted ? "1px solid var(--teal-bright)" : swapChecked ? "1px solid var(--teal)" : "1px solid var(--border)", borderRadius: 8, padding: 12, marginBottom: 8, marginLeft: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={swapChecked} onChange={() => toggleSwap(rowKey, [])} /> Planned
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: approveWouldViolateFloor ? "not-allowed" : "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={swapAccepted} disabled={approveWouldViolateFloor} onChange={() => toggleAcceptedSwap(p, rowKey, swapIns)} /> Approved in FLICA
                          </label>
                          <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer", fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--sans)" }}>
                            <input type="checkbox" checked={deniedSwapKeys.has(rowKey)} onChange={() => toggleDeniedSwap(p, rowKey, swapIns)} /> Denied
                          </label>
                          <span style={{ color: "var(--text-primary)", fontFamily: "var(--mono)", fontSize: 13 }}>
                            Drop {p.a.pairing} + {p.b.pairing} → swap into {swapIns.map((si) => `${si.pairing} (${si.dateTok})`).join(" + ")}
                          </span>
                        </div>
                        <div style={{ fontSize: 12, color: p.wantsOverlap ? "var(--amber)" : "var(--text-muted)", fontFamily: "var(--sans)" }}>
                          Frees {freedKeys.length} day{freedKeys.length === 1 ? "" : "s"}{p.wantsOverlap ? " · includes a wanted day" : ""}
                        </div>
                      </div>
                      {approveWouldViolateFloor && (() => {
                        const shortfall = 60 - floorProjection;
                        const floorFixes = getFloorFixSuggestions(shortfall, [p.a.key, p.b.key]);
                        return (
                          <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 8 }}>
                            Can't approve this swap yet — it would take your worked total to {floorProjection.toFixed(2)}h, under the 60h floor. Still fine to mark Planned and compare against other ways to get there.
                            {floorFixes.length > 0 ? (
                              <div style={{ marginTop: 4 }}>
                                Ways to clear the floor first:
                                <ul style={{ margin: "4px 0 0 18px", padding: 0 }}>
                                  {floorFixes.map((fx, i) => (
                                    <li key={i}>{fx.label} — brings you to {(floorProjection + fx.credit).toFixed(2)}h</li>
                                  ))}
                                </ul>
                                {floorFixes.some((fx) => fx.kind === "trade") && (
                                  <div style={{ marginTop: 4, fontStyle: "italic" }}>
                                    Trade Board listings are usually a straight drop, not a swap-for-swap request — check what this specific posting actually says on FLICA before counting on it. If they just want it gone, it's really a normal (non-SDO) pickup, not a trade. If they do want something specific back, that's between you and them to work out on FLICA — this tool can't confirm what they'll accept.
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div style={{ marginTop: 4, fontStyle: "italic" }}>No current Add, Trade Board pickup, or Trade would clear the floor for this swap yet.</div>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
                <div className="hint" style={{ marginTop: -4 }}>These two trips only work together, not separately — accepting one without the other would leave a black/red day genuinely uncovered.</div>
              </div>
            )}
            <div className="hint">FLICA won't let you drop a trip for nothing — a Swap has to give up something in return. Every combination shown here avoids your other trips and keeps you under {effectiveMaxConsecutive} consecutive working days; not every request gets approved, so having several ways to free the same days gives you a fallback. That swap itself won't earn SDO — only a later Add does.</div>
          </>
        ) : (
          <div className="hint" style={{ marginTop: 0 }}>
            {!scheduleParsed
              ? "Paste and parse your current schedule above to see swap candidates."
              : droppableTrips.length === 0
              ? "No trips found in the parsed schedule."
              : !hasGridData
              ? "No trips are droppable yet — the Reserve Grid hasn't been loaded, so every day defaults to unconfirmed and can't be cleared for a drop. Paste or enter it above."
              : swapRecs.length < 2
              ? `Only ${swapRecs.length} trip${swapRecs.length === 1 ? "" : "s"} on your schedule ${swapRecs.length === 1 ? "isn't" : "aren't"} flagged SDO — a drop needs at least two non-SDO trips to swap together, since FLICA won't let you give one up for nothing.`
              : "No open-time trip on the current board can cover the black/red days in any pair while also avoiding your other trips — try pasting more of the board."}
          </div>
        ))}

        {deniedSwapKeys.size > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Denied swaps (hidden from recommendations)</div>
            {[...deniedSwapKeys].map((key) => {
              const [pairKeyPart, swapInIdPart] = key.split("::");
              const [aKey, bKey] = (pairKeyPart || "").split("__");
              const label = `${(aKey || "?").split("-")[0]} + ${(bKey || "?").split("-")[0]} → ${(swapInIdPart || "?").split("-")[0]}`;
              return (
                <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-faint)", marginBottom: 4 }}>
                  <span>{label}</span>
                  <button className="action small" onClick={() => logAndRun(`Restored swap ${label}`, () => doUndenySwap(key), `Denied swap ${label}`, () => doDenySwap({ a: { pairing: (aKey || "?").split("-")[0] }, b: { pairing: (bKey || "?").split("-")[0] } }, key))}>Restore</button>
                </div>
              );
            })}
          </div>
        )}


        {scheduleParsed && droppableTrips.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setTbPostSectionOpen((v) => !v)}>
              <div className="h" style={{ marginBottom: 0 }}>Post to Trade Board — candidates</div>
              <button className="action small" onClick={(e) => { e.stopPropagation(); setTbPostSectionOpen((v) => !v); }}>{tbPostSectionOpen ? "Hide" : "Show"}</button>
            </div>
            {tbPostSectionOpen && (tradePostCandidates.length > 0 ? (
              <table style={{ marginBottom: 24 }}>
                <thead><tr><th>Requested</th><th>Approved</th><th>Pairing</th><th>Dates</th><th>Why</th></tr></thead>
                <tbody>
                  {tradePostCandidates.map((t, i) => {
                    const isReq = tbDropRequested.has(t.key);
                    const isAcc = tbDropAccepted.has(t.key);
                    return (
                      <tr key={i}>
                        <td><input type="checkbox" checked={isReq || isAcc} disabled={isAcc} onChange={() => toggleTbDropRequested(t)} /></td>
                        <td><input type="checkbox" checked={isAcc} onChange={() => toggleTbDropAccepted(t)} /></td>
                        <td style={{ color: "var(--text-primary)" }}>{t.pairing}</td>
                        <td>day {t.startDay} +{t.days - 1}d</td>
                        <td style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--text-muted)" }}>Not flagged Premium or SDO — whoever picks it up takes over these exact days, so the Reserve Grid doesn't matter here.</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="hint" style={{ marginTop: 0 }}>
                {droppableTrips.filter((t) => !t.isSdo && !t.isLocked).length === 0
                  ? "Every remaining trip is either flagged SDO or locked, so there's nothing to post."
                  : "Every remaining non-SDO, unlocked trip is flagged Premium — posting one would give away extra value, so none are suggested here."}
              </div>
            ))}
          </>
        )}

        {enrichedTrade.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setTbAddSectionOpen((v) => !v)}>
              <div className="h" style={{ marginBottom: 0 }}>Add from Trade Board — no SDO, evaluate on credit/quality of life only</div>
              <button className="action small" onClick={(e) => { e.stopPropagation(); setTbAddSectionOpen((v) => !v); }}>{tbAddSectionOpen ? "Hide" : "Show"}</button>
            </div>
            {tbAddSectionOpen && <table style={{ marginBottom: 24 }}>
              <thead><tr><th>Requested</th><th>Approved</th><th>Pairing</th><th>Dates</th><th>Credit</th><th>Layover</th><th>Status</th></tr></thead>
              <tbody>
                {enrichedTrade.slice().sort((a, b) => (b.creditHours || 0) - (a.creditHours || 0)).map((t) => {
                  const isReq = tbAddRequested.has(t.id);
                  const isAcc = tbAddAccepted.has(t.id);
                  return (
                    <tr key={t.id}>
                      <td><input type="checkbox" checked={isReq || isAcc} disabled={isAcc || !t.feasible} onChange={() => toggleTbAddRequested(t)} /></td>
                      <td><input type="checkbox" checked={isAcc} disabled={!t.feasible && !isAcc} onChange={() => toggleTbAddAccepted(t)} /></td>
                      <td style={{ color: "var(--text-primary)" }}>{t.pairing}</td>
                      <td>{t.dateTok} +{t.days - 1}d</td>
                      <td>{formatHours(t.creditHours)}</td>
                      <td style={{ fontFamily: "var(--sans)", color: "var(--text-muted)" }}>{t.layover}</td>
                      <td style={{ fontSize: 11, color: t.feasible ? "var(--teal-bright)" : "var(--amber-strong)" }}>{t.feasible ? "Feasible now — no SDO" : `Needs ${t.missing.length} more day(s) off`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>}
          </>
        )}

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20, marginBottom: 24 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }} onClick={() => setTradeSectionOpen((v) => !v)}>
            <div className="h" style={{ marginBottom: 0 }}>Non-SDO Trip Trades</div>
            <button className="action small" onClick={(e) => { e.stopPropagation(); setTradeSectionOpen((v) => !v); }}>{tradeSectionOpen ? "Hide" : "Show"}</button>
          </div>
          {tradeSectionOpen && (
            <>
              <div className="hint">Give one of your trips away and receive a specific one back — neither side needs the Reserve Grid, since the other crewmember takes over your old days exactly as you take over theirs. Never earns SDO. Updates your schedule and every recommendation immediately.</div>
              <label className="chk" style={{ display: "block", marginBottom: 12 }}>
                <input type="checkbox" checked={allowSdoTrade} onChange={(e) => setAllowSdoTrade(e.target.checked)} /> Also allow trading a trip already flagged SDO (gives up its bonus)
              </label>
              <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 14 }}>
                <div style={{ minWidth: 220 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Give away</div>
                  <select value={tradeOutgoingKey} onChange={(e) => setTradeOutgoingKey(e.target.value)} style={{ width: "100%" }}>
                    <option value="">Select one of your trips…</option>
                    {droppableTrips.filter((t) => (!t.isSdo || allowSdoTrade) && !tradeDetails.has(t.key)).map((t) => (
                      <option key={t.key} value={t.key}>{t.pairing} — day {t.startDay} +{t.days - 1}d{t.isPremium ? " (premium)" : ""}{t.isSdo ? " (SDO — gives up bonus)" : ""}</option>
                    ))}
                  </select>
                </div>
                <div style={{ minWidth: 260 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 6 }}>Receive</div>
                  <div style={{ display: "flex", gap: 14, marginBottom: 8 }}>
                    <label className="chk"><input type="radio" checked={tradeIncomingMode === "openpot"} onChange={() => setTradeIncomingMode("openpot")} /> From Opentime pot</label>
                    <label className="chk"><input type="radio" checked={tradeIncomingMode === "board"} onChange={() => setTradeIncomingMode("board")} /> From TradeBoard</label>
                    <label className="chk"><input type="radio" checked={tradeIncomingMode === "manual"} onChange={() => setTradeIncomingMode("manual")} /> Enter manually</label>
                  </div>
                  {tradeIncomingMode === "openpot" ? (
                    <select value={tradeIncomingOpenPotId} onChange={(e) => setTradeIncomingOpenPotId(e.target.value)} style={{ width: "100%" }}>
                      <option value="">Select an Opentime pot trip…</option>
                      {enrichedOpen.map((t) => (
                        <option key={t.id} value={t.id}>{t.pairing} — {t.dateTok} +{t.days - 1}d, {formatHours(t.creditHours)}{t.eligible ? "" : " (not SDO-eligible on its own — fine for a trade)"}</option>
                      ))}
                    </select>
                  ) : tradeIncomingMode === "board" ? (
                    <select value={tradeIncomingBoardId} onChange={(e) => setTradeIncomingBoardId(e.target.value)} style={{ width: "100%" }}>
                      <option value="">Select a Trade Board pairing…</option>
                      {allTradeTrips.map((t) => (
                        <option key={t.id} value={t.id}>{t.pairing} — {t.dateTok} +{t.days - 1}d, {formatHours(t.creditHours)}</option>
                      ))}
                    </select>
                  ) : (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <input type="text" placeholder="Pairing" value={tradeManualPairing} onChange={(e) => setTradeManualPairing(e.target.value)} style={{ width: 90 }} />
                      <input type="text" placeholder="09SEP" value={tradeManualDateTok} onChange={(e) => setTradeManualDateTok(e.target.value)} style={{ width: 70 }} />
                      <input type="text" placeholder="Days" value={tradeManualDays} onChange={(e) => setTradeManualDays(e.target.value)} style={{ width: 50 }} />
                      <input type="text" placeholder="Credit 1636" value={tradeManualCreditRaw} onChange={(e) => setTradeManualCreditRaw(e.target.value)} style={{ width: 90 }} />
                      <input type="text" placeholder="Overnights" value={tradeManualLayover} onChange={(e) => setTradeManualLayover(e.target.value)} style={{ width: 130 }} />
                    </div>
                  )}
                </div>
              </div>
              <button className="action" onClick={performTrade}>Record trade</button>
              {tradeFormError && <span style={{ marginLeft: 12, fontSize: 13, color: "var(--amber-strong)" }}>{tradeFormError}</span>}

              {tradeDetails.size > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>Trades recorded</div>
                  {[...tradeDetails.entries()].map(([key, d]) => (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, fontFamily: "var(--mono)", color: "var(--text-secondary)", marginBottom: 4 }}>
                      <span>{d.outgoingPairing} → {d.incoming.pairing} ({d.incoming.dateTok})</span>
                      <button className="action small" onClick={() => undoTrade(key)}>Undo</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 20 }}>
          <div className="h">Your plan</div>

          {plannedOrder.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8 }}>
                Priority order — reorder to match the sequence you plan to submit requests in. Only non-conflicting picks, highest priority first, count toward the totals below.
              </div>
              {projection.resolved.map((entry, idx) => (
                <div key={`${entry.type}-${entry.id}`} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", marginBottom: 4,
                  border: `1px solid ${entry.included ? "var(--border-teal-soft)" : "var(--border-danger-soft)"}`, borderRadius: 6,
                  background: entry.included ? "var(--teal-tint)" : "var(--amber-tint)",
                }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-faint)", width: 18 }}>{idx + 1}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                    <button className="action small" onClick={() => movePlannedOrder(idx, -1)} disabled={idx === 0} style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }}>↑</button>
                    <button className="action small" onClick={() => movePlannedOrder(idx, 1)} disabled={idx === projection.resolved.length - 1} style={{ padding: "0 6px", fontSize: 10, lineHeight: 1.4 }}>↓</button>
                  </div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text-primary)", flex: 1 }}>
                    {entry.type === "swap" ? "Swap: " : "Add: "}{entry.label}
                  </span>
                  <span style={{ fontSize: 11, color: entry.included ? "var(--teal-bright)" : "var(--amber-strong)", fontFamily: "var(--sans)" }}>
                    {entry.included ? "Counted" : entry.reason}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Swaps planned</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{selectedSwaps.size}</div></div>
            <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Trips selected</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{selectedTrips.length}</div></div>
            <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Counted toward pay</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{projectedTrips.length} / {selectedTrips.length}</div></div>
            <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Days off used</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{daysOffUsed} / {daysOffMarked}</div></div>
          </div>

          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 20 }}>
            <div style={{ flex: "1 1 260px", border: "1px solid var(--border-teal-soft)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: "var(--teal-bright)", marginBottom: 8, fontWeight: 500 }}>Actual total — approved only</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600, marginBottom: 10 }}>{formatMoney(actualTotal)}</div>
              <div style={{ display: "flex", gap: 24, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Confirmed credit hours</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 15 }}>{formatHours(totalConfirmedCreditHours)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Confirmed bonus</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--teal-bright)" }}>{formatMoney(confirmedBonusHours * hourlyRate)}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Confirmed bonus credit hours</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 15, color: "var(--teal-bright)" }}>{formatHours(confirmedBonusHours)}</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>
                {confirmedBonusHours === 0
                  ? `No confirmed SDO yet — confirmed credit hours is just your baseline, ${formatHours(baselineHours)}.`
                  : baselineHours >= GUARANTEE_HOURS
                  ? `Worked ${formatHours(baselineHours)} with SDO involved, clears the ${GUARANTEE_HOURS}h guarantee, so pay is based on ${GUARANTEE_HOURS}h + ${formatHours(confirmedBonusHours)} confirmed SDO bonus (${formatHours(preExistingSdoBonusHours)} from SDO trips already on your schedule, ${formatHours(acceptedBonusHours)} approved through this tool).`
                  : `Worked ${formatHours(baselineHours)}, under the ${GUARANTEE_HOURS}h guarantee, so pay is based on actual worked hours + ${formatHours(confirmedBonusHours)} confirmed SDO bonus (${formatHours(preExistingSdoBonusHours)} from SDO trips already on your schedule, ${formatHours(acceptedBonusHours)} approved through this tool).`}
                {" "}Nothing still-planned counts here.
              </div>
            </div>
            <div style={{ flex: "1 1 260px", border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, fontWeight: 500 }}>Planned total — approved + prioritized planned</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 22, fontWeight: 600, marginBottom: 6 }}>{formatMoney(plannedTotal)}</div>
              <div style={{ fontSize: 11, color: "var(--text-faint)" }}>Actual total, plus {formatHours(totalCreditHours)} credit ({formatMoney(totalCreditHours * hourlyRate + totalBonusPay)}) from the highest-priority planned picks that don't conflict with each other. Drops back to the actual total for anything later approved or denied.</div>
            </div>
          </div>

          {sickAndBerCreditDelta !== 0 && <div style={{ fontSize: 12, color: sickAndBerCreditDelta >= 0 ? "var(--teal-bright)" : "var(--amber-strong)", marginTop: 14 }}>Sick Bank / bereavement adjustment folded into your Actual total: {formatSignedHours(sickAndBerCreditDelta)} ({formatMoney(sickAndBerCreditDelta * hourlyRate)}).</div>}
          {swapDependentSelected > 0 && <div style={{ fontSize: 12, color: "var(--amber)", marginTop: 14 }}>{swapDependentSelected} counted trip{swapDependentSelected === 1 ? "" : "s"} depend{swapDependentSelected === 1 ? "s" : ""} on a swap above going through first — the planned total assumes it does.</div>}
          {belowFloor && <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 14 }}>Trips can't be swapped below 60 credit hours in a month — your worked total is under that floor.</div>}
          {daysOffMarked > 0 && daysOffUsed >= daysOffMarked - 1 && <div style={{ fontSize: 12, color: "var(--amber-strong)", marginTop: 14 }}>You're close to using up every marked day off — your contract still requires minimum days off blocks each month, so keep enough clear.</div>}

          {(acceptedTrips.length > 0 || acceptedSwaps.size > 0) && (
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 20, paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--teal-bright)", marginBottom: 12 }}>Approved in FLICA so far</div>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Swaps approved</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{acceptedSwaps.size}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Adds approved</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{acceptedTrips.length}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Credit confirmed</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{formatHours(acceptedCreditHours)}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>SDO bonus confirmed</div><div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--teal-bright)" }}>{formatMoney(acceptedBonusPay)}</div></div>
              </div>
              {acceptedSwapDetails.size > 0 && (
                <div style={{ marginTop: 12 }}>
                  {[...acceptedSwapDetails.entries()].map(([key, d]) => (
                    <div key={key} style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--mono)", marginBottom: 3 }}>
                      Dropped {d.aPairing} + {d.bPairing} → swapped into {d.swapIns && d.swapIns.length ? d.swapIns.map((si) => `${si.pairing} (${si.dateTok})`).join(" + ") : "an unidentified trip"}
                    </div>
                  ))}
                </div>
              )}
              {acceptedSwaps.size > 0 && (
                <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 10 }}>
                  Approved Adds update your baseline credit automatically since their hours are known exactly. Approved swaps do too, but only if you entered credit hours for both dropped trips in "Your trips" above (the swap-in's credit is always known from the board) — otherwise baseline is left untouched and you'll need to adjust it by hand.
                </div>
              )}
            </div>
          )}

          {(tbAddRequested.size > 0 || tbDropRequested.size > 0) && (
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 20, paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--teal-bright)", marginBottom: 12 }}>Trade Board activity</div>
              <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Adds requested</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{tbAddRequested.size}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Adds approved</div><div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--teal-bright)" }}>{tbAddAccepted.size}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Drops posted</div><div style={{ fontFamily: "var(--mono)", fontSize: 18 }}>{tbDropRequested.size}</div></div>
                <div><div style={{ fontSize: 12, color: "var(--text-muted)" }}>Drops approved (picked up)</div><div style={{ fontFamily: "var(--mono)", fontSize: 18, color: "var(--teal-bright)" }}>{tbDropAccepted.size}</div></div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text-faint)", marginTop: 10 }}>
                Accepting a Trade Board add works the same as an Opentime pot Add — credit and days off update automatically, but never earns SDO. Accepting a Trade Board drop removes that trip from your live schedule entirely and frees its days, since a trade is a straight handoff — no compensating swap-in needed.
              </div>
            </div>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 24, paddingTop: 20 }}>
          <div className="h">Change log</div>
          {changeLog.length === 0 ? (
            <div className="hint" style={{ marginTop: 0 }}>No changes yet — accept, deny, or restore something above and it'll show up here, in order, with a one-click revert.</div>
          ) : (
            <div>
              {changeLog.map((entry, idx) => !entry.reverted && (
                <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", marginBottom: 4, border: "1px solid var(--border)", borderRadius: 6 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-faint)", width: 22 }}>{idx + 1}</span>
                  <span style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-primary)", flex: 1 }}>{entry.description}</span>
                  <button className="action small" onClick={() => handleRevertClick(entry.id)}>Revert</button>
                </div>
              ))}
              {changeLog.some((e) => e.reverted) && (
                <div style={{ marginTop: 8 }}>
                  <button className="action small" onClick={() => setShowRevertedLog((v) => !v)}>
                    {showRevertedLog ? "Hide" : "Show"} {changeLog.filter((e) => e.reverted).length} reverted change{changeLog.filter((e) => e.reverted).length === 1 ? "" : "s"}
                  </button>
                  {showRevertedLog && (
                    <div style={{ marginTop: 8 }}>
                      {changeLog.map((entry, idx) => entry.reverted && (
                        <div key={entry.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", marginBottom: 4, border: "1px solid var(--border)", borderRadius: 6, opacity: 0.55 }}>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-faint)", width: 22 }}>{idx + 1}</span>
                          <span style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--text-primary)", flex: 1 }}>{entry.description}</span>
                          <button className="action small" disabled style={{ opacity: 0.6, cursor: "default" }}>Reverted</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
