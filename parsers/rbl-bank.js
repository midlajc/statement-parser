import * as XLSX from "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";

const DATE_RE = /^\d{2}\/\d{2}\/(\d{2}|\d{4})$/;

const EXPECTED_HEADERS = [
  "transaction date",
  "transaction details",
  "cheque id",
  "value date",
  "withdrawl amt",
  "deposit amt",
  "balance (inr)",
];

function normalise(val) {
  if (val === null || val === undefined) return "";
  return String(val).trim();
}

function parseExcelDate(val) {
  if (!val) return "";
  if (val instanceof Date) {
    const d = val.getDate().toString().padStart(2, "0");
    const m = (val.getMonth() + 1).toString().padStart(2, "0");
    const y = val.getFullYear();
    return `${d}/${m}/${y}`;
  }
  if (typeof val === "number") {
    const date = XLSX.SSF.parse_date_code(val);
    if (date) {
      const d = String(date.d).padStart(2, "0");
      const m = String(date.m).padStart(2, "0");
      return `${d}/${m}/${date.y}`;
    }
  }
  const str = String(val).trim();
  if (DATE_RE.test(str)) return str;
  return "";
}

function parseAmount(val) {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "number") return val;
  const cleaned = String(val).replace(/,/g, "").replace(/^INR\s*/i, "").trim();
  if (!cleaned) return "";
  const num = Number(cleaned);
  return Number.isNaN(num) ? "" : num;
}

function findHeaderRow(sheet) {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let r = range.s.r; r <= Math.min(range.e.r, 60); r++) {
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
    throw new Error("Could not find RBL bank statement headers in this file.");
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

    const rawFirstCol = normalise(get("transaction date"));

    // Stop at the summary section
    if (rows.length > 0 && /^(statement summary|opening balance|closing balance)/i.test(rawFirstCol)) break;

    const date = parseExcelDate(get("transaction date"));
    if (!date || !DATE_RE.test(date)) continue;

    const description = normalise(get("transaction details"));
    const referenceNumber = normalise(get("cheque id"));
    const withdrawals = parseAmount(get("withdrawl amt"));
    const deposits = parseAmount(get("deposit amt"));
    const closingBalance = parseAmount(get("balance (inr)"));

    if (withdrawals === "" && deposits === "") continue;

    rows.push({
      date,
      withdrawals,
      deposits,
      payee: "",
      description,
      reference_number: referenceNumber,
      closing_balance: closingBalance,
    });
  }

  const sorted = sortByDateThenBalanceChain(rows);

  return { rows: sorted, format: "default" };
}

function dateKey(dateStr) {
  const parts = dateStr.split("/");
  const year = parts[2].length === 2 ? 2000 + Number(parts[2]) : Number(parts[2]);
  return new Date(year, Number(parts[1]) - 1, Number(parts[0])).getTime();
}

function sortByDateThenBalanceChain(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  const dates = [...byDate.keys()].sort((a, b) => dateKey(a) - dateKey(b));

  const result = [];
  for (const date of dates) {
    const group = byDate.get(date);
    result.push(...chainByBalance(group));
  }
  return result;
}

function chainByBalance(group) {
  if (group.length <= 1) return group;

  const net = (t) => (Number(t.deposits) || 0) - (Number(t.withdrawals) || 0);
  const close = (t) => {
    const v = Number(t.closing_balance);
    return Number.isFinite(v) ? v : null;
  };
  const pre = (t) => {
    const c = close(t);
    return c === null ? null : c - net(t);
  };
  const key = (n) => (n === null ? null : n.toFixed(2));

  // If any row lacks a closing balance, balance chaining is unreliable — keep source order.
  if (group.some((t) => close(t) === null)) return group;

  const closes = new Set(group.map((t) => key(close(t))));

  const head = group.find((t) => !closes.has(key(pre(t))));
  if (!head) return group;

  const chain = [head];
  const remaining = group.filter((t) => t !== head);
  let current = head;
  while (remaining.length) {
    const idx = remaining.findIndex((t) => key(pre(t)) === key(close(current)));
    if (idx === -1) break;
    current = remaining.splice(idx, 1)[0];
    chain.push(current);
  }
  chain.push(...remaining);
  return chain;
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
  id: "rbl-bank",
  name: "RBL Bank Account",
  description: "Parse RBL bank account statement Excel files into CSV",
  icon: "🏛️",
  accept: ".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  fileLabel: "statement Excel file",
  needsPassword: false,
  parseFile,
  getColumns,
  isValidFile,
};
