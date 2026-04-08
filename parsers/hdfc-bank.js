import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

const DATE_RE = /^\d{2}\/\d{2}\/(\d{2}|\d{4})$/;
const STOP_MARKERS = /^(\*+|statement summary|opening balance|closing balance)/i;

const EXPECTED_HEADERS = [
  "date",
  "narration",
  "chq./ref.no.",
  "value dt",
  "withdrawal amt.",
  "deposit amt.",
  "closing balance",
];

function normalise(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

function parseExcelDate(val) {
  if (!val) return "";
  // If SheetJS gives a JS Date
  if (val instanceof Date) {
    const d = val.getDate().toString().padStart(2, "0");
    const m = (val.getMonth() + 1).toString().padStart(2, "0");
    const y = val.getFullYear();
    return `${d}/${m}/${y}`;
  }
  // If it's a serial number
  if (typeof val === "number") {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) {
      const d = String(date.d).padStart(2, "0");
      const m = String(date.m).padStart(2, "0");
      return `${d}/${m}/${date.y}`;
    }
  }
  // String date — return as-is (e.g. "01/04/26")
  const str = String(val).trim();
  if (DATE_RE.test(str)) return str;
  return "";
}

function parseAmount(val) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isNaN(num) ? "" : num;
}

function findHeaderRow(sheet) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let r = range.s.r; r <= Math.min(range.e.r, 20); r++) {
    const cells = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = sheet[addr];
      cells.push(cell ? normalise(cell.v).toLowerCase() : "");
    }
    const matches = EXPECTED_HEADERS.filter((h) => cells.includes(h));
    if (matches.length >= 5) {
      return r;
    }
  }
  return -1;
}

async function parseFile(file) {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const headerRow = findHeaderRow(sheet);
  if (headerRow === -1) {
    throw new Error("Could not find HDFC bank statement headers in this file.");
  }

  const jsonData = XLSX.utils.sheet_to_json(sheet, {
    range: headerRow,
    defval: "",
  });

  const rows = [];
  for (const raw of jsonData) {
    const keys = Object.keys(raw);
    const lowerKeys = keys.map((k) => k.toLowerCase().trim());

    const get = (header) => {
      const idx = lowerKeys.indexOf(header);
      return idx !== -1 ? raw[keys[idx]] : "";
    };

    const date = parseExcelDate(get("date"));

    const rawDate = normalise(get("date"));
    const rawNarration = normalise(get("narration"));

    // Stop at summary section (only after we've found real data)
    if (rows.length > 0 && /^(statement summary|opening balance|closing balance)/i.test(rawNarration)) break;

    // Skip separator rows and rows without a valid date
    if (!date || !DATE_RE.test(date)) continue;

    const narration = rawNarration;
    const refNo = normalise(get("chq./ref.no."));
    const valueDt = parseExcelDate(get("value dt"));
    const withdrawal = parseAmount(get("withdrawal amt."));
    const deposit = parseAmount(get("deposit amt."));
    const closingBalance = parseAmount(get("closing balance"));

    // Skip rows with no actual transaction amounts
    if (withdrawal === "" && deposit === "") continue;

    rows.push({
      date,
      withdrawals: withdrawal,
      deposits: deposit,
      payee: "",
      description: narration,
      reference_number: refNo,
    });
  }

  rows.sort((a, b) => {
    const pa = a.date.split("/");
    const pb = b.date.split("/");
    const ya = pa[2].length === 2 ? 2000 + Number(pa[2]) : Number(pa[2]);
    const yb = pb[2].length === 2 ? 2000 + Number(pb[2]) : Number(pb[2]);
    return new Date(ya, pa[1] - 1, pa[0]) - new Date(yb, pb[1] - 1, pb[0]);
  });

  return { rows, format: "default" };
}

function getColumns() {
  return ["date", "withdrawals", "deposits", "payee", "description", "reference_number"];
}

function isValidFile(file) {
  const name = (file.name || "").toLowerCase();
  const mimeType = (file.type || "").toLowerCase();
  return (
    name.endsWith(".xls") ||
    name.endsWith(".xlsx") ||
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
}

export default {
  id: "hdfc-bank",
  name: "HDFC Bank Account",
  description: "Parse HDFC bank account statement Excel files into CSV",
  icon: "🏦",
  accept: ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileLabel: "statement Excel file",
  needsPassword: false,
  parseFile,
  getColumns,
  isValidFile,
};
