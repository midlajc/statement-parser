import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

// "01/04/26", "01/04/2026" (classic statement) or "15-Oct-2026" (net banking export)
const SLASH_DATE_RE = /^\d{2}\/\d{2}\/(\d{2}|\d{4})$/;
const MONTH_DATE_RE = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const AMOUNT_RE = /^-?[\d,]+\.\d{2}$/;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const LINE_Y_TOLERANCE = 3;
// Header labels can wrap onto a second line ("Transaction" / "Date")
const HEADER_WRAP_GAP = 11;
// Words closer than this belong to the same header cell ("Debit" "Amount")
const HEADER_WORD_GAP = 8;

// Order matters: "Value Date" must win over the plain "Date" column
const COLUMN_LABELS = [
  { key: "closing_balance", re: /closing/i },
  { key: "withdrawal", re: /withdrawal|debit/i },
  { key: "deposit", re: /deposit|credit/i },
  { key: "value_date", re: /value/i },
  { key: "ref_no", re: /chq|ref/i },
  { key: "narration", re: /narration|description|particulars/i },
  { key: "date", re: /date/i },
];
const AMOUNT_KEYS = ["withdrawal", "deposit", "closing_balance"];

// Lines that end the transaction table on a page (footers, summary)
const STOP_RE =
  /^(statement summary|end of statement|hdfc bank limited|page no|\*closing balance|contents of this statement|registered office)/i;

function parseAmount(str) {
  const num = Number(String(str).replace(/,/g, ""));
  return Number.isNaN(num) ? "" : num;
}

function parseDate(str) {
  if (!str) return "";
  if (SLASH_DATE_RE.test(str)) return str;
  const m = str.match(MONTH_DATE_RE);
  if (!m) return "";
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  if (!month) return "";
  return `${m[1]}/${String(month).padStart(2, "0")}/${m[3]}`;
}

function dateKey(row) {
  const [d, m, y] = row.date.split("/").map(Number);
  const year = y < 100 ? 2000 + y : y;
  return `${year}${String(m).padStart(2, "0")}${String(d).padStart(2, "0")} ${row.time || ""}`;
}

async function extractPageLines(page) {
  const textContent = await page.getTextContent();
  const items = [];
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const x = item.transform[4];
    const y = item.transform[5];
    items.push({ str: item.str.trim(), x, y, right: x + item.width });
  }

  // Top-to-bottom, then left-to-right
  items.sort((a, b) => b.y - a.y || a.x - b.x);

  const lines = [];
  for (const item of items) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - item.y) <= LINE_Y_TOLERANCE) {
      line.items.push(item);
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map((i) => i.str).join(" ");
  }
  return lines;
}

function isHeaderLine(line) {
  return /closing balance/i.test(line.text) && /withdrawal|debit/i.test(line.text) && /deposit|credit/i.test(line.text);
}

// Builds column boundaries from the header line (plus a wrapped second line, if any).
// Returns the columns and how many lines the header occupied.
function findColumns(lines, index) {
  const cells = [];
  for (const item of lines[index].items) {
    const last = cells[cells.length - 1];
    if (last && item.x - last.right < HEADER_WORD_GAP) {
      last.text += ` ${item.str}`;
      last.right = item.right;
    } else {
      cells.push({ text: item.str, start: item.x, right: item.right });
    }
  }

  let used = 1;
  const next = lines[index + 1];
  if (next && lines[index].y - next.y <= HEADER_WRAP_GAP) {
    used = 2;
    for (const item of next.items) {
      const center = (item.x + item.right) / 2;
      const cell = cells.find((c) => center >= c.start && center <= c.right);
      if (cell) cell.text += ` ${item.str}`;
    }
  }

  const columns = [];
  const taken = new Set();
  for (const cell of cells) {
    const label = COLUMN_LABELS.find((l) => l.re.test(cell.text) && !taken.has(l.key));
    if (!label) continue;
    taken.add(label.key);
    columns.push({ key: label.key, start: cell.start, right: cell.right });
  }
  if (columns.length < 6) return null;

  // A column owns everything up to the middle of the gap before the next header
  for (let i = 0; i < columns.length; i++) {
    const nextCol = columns[i + 1];
    columns[i].end = nextCol ? (columns[i].right + nextCol.start) / 2 : Infinity;
  }
  return { columns, used };
}

function splitLine(line, columns) {
  const cells = {};
  for (const item of line.items) {
    const center = (item.x + item.right) / 2;
    const col = columns.find((c) => center < c.end) || columns[columns.length - 1];
    cells[col.key] = cells[col.key] ? `${cells[col.key]} ${item.str}` : item.str;
  }
  return cells;
}

function appendWrapped(text, more) {
  if (!text) return more;
  // Wrapped words split on "-" or "/" continue without a space
  return /[-/]$/.test(text) ? `${text}${more}` : `${text} ${more}`;
}

// Use the running balance to fix any withdrawal/deposit the layout put in the wrong column
function reconcileWithBalance(rows) {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].closing_balance;
    const row = rows[i];
    if (prev === "" || row.closing_balance === "") continue;
    const amount = row.withdrawal !== "" ? row.withdrawal : row.deposit;
    if (amount === "") continue;
    const delta = Math.round((row.closing_balance - prev) * 100) / 100;
    if (delta === amount && row.withdrawal !== "") {
      row.deposit = amount;
      row.withdrawal = "";
    } else if (delta === -amount && row.deposit !== "") {
      row.withdrawal = amount;
      row.deposit = "";
    }
  }
}

async function parseFile(file, password) {
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data, password: password || undefined }).promise;

  const rows = [];
  let columns = null;
  let current = null;
  let done = false;

  for (let pageNum = 1; pageNum <= pdf.numPages && !done; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const lines = await extractPageLines(page);
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (isHeaderLine(line)) {
        const header = findColumns(lines, i);
        if (header) {
          columns = header.columns;
          inTable = true;
          i += header.used - 1;
          continue;
        }
      }
      if (!inTable || !columns) continue;

      if (STOP_RE.test(line.text)) {
        inTable = false;
        if (/^(statement summary|end of statement)/i.test(line.text)) done = true;
        continue;
      }

      const cells = splitLine(line, columns);
      const date = parseDate(cells.date);
      const hasAmount = AMOUNT_KEYS.some((k) => cells[k] && AMOUNT_RE.test(cells[k]));

      if (date) {
        current = {
          date,
          time: "",
          narration: cells.narration || "",
          ref_no: cells.ref_no || "",
          value_date: parseDate(cells.value_date),
          withdrawal: cells.withdrawal ? parseAmount(cells.withdrawal) : "",
          deposit: cells.deposit ? parseAmount(cells.deposit) : "",
          closing_balance: cells.closing_balance ? parseAmount(cells.closing_balance) : "",
        };
        rows.push(current);
        continue;
      }

      // Continuation line: transaction time, wrapped narration / reference number
      if (current && !hasAmount) {
        if (cells.date && TIME_RE.test(cells.date)) current.time = cells.date;
        if (cells.narration) current.narration = appendWrapped(current.narration, cells.narration);
        if (cells.ref_no) current.ref_no += cells.ref_no;
      }
    }
  }

  if (!columns) {
    throw new Error("Could not find HDFC bank statement headers in this PDF.");
  }

  let txns = rows.filter((r) => r.withdrawal !== "" || r.deposit !== "");

  // Net banking exports list newest first; put everything in chronological order
  if (txns.length > 1 && dateKey(txns[0]) > dateKey(txns[txns.length - 1])) {
    txns.reverse();
  }
  txns = txns
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => dateKey(a.row).localeCompare(dateKey(b.row)) || a.idx - b.idx)
    .map((x) => x.row);

  reconcileWithBalance(txns);

  const result = txns.map((r) => ({
    date: r.date,
    withdrawals: r.withdrawal,
    deposits: r.deposit,
    payee: "",
    description: r.narration,
    reference_number: r.ref_no,
  }));

  return { rows: result, format: "default" };
}

function getColumns() {
  return ["date", "withdrawals", "deposits", "payee", "description", "reference_number"];
}

function isValidFile(file) {
  const mimeType = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return mimeType === "application/pdf" || name.endsWith(".pdf");
}

export default {
  id: "hdfc-bank-pdf",
  name: "HDFC Bank Account",
  description: "Parse HDFC bank account statement PDFs into CSV",
  icon: "🏦",
  accept: ".pdf,application/pdf",
  fileLabel: "statement PDF",
  needsPassword: true,
  parseFile,
  getColumns,
  isValidFile,
};
