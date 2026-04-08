import * as pdfjsLib from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

const DATE_TIME_RE = /^\s*(\d{2}\/\d{2}\/\d{4})\s*\|\s*(\d{2}:\d{2})\s*(.*)$/;
const DATE_RE = /(\d{2}\/\d{2}\/\d{4})/;
const TIME_RE = /(\d{2}:\d{2})/;
const FOREX_RE = /\b(?<currency>[A-Z]{3})\b\s+(?<amount>[\d,]+(?:\.\d{1,2})?)\s*$/;

function cleanAmount(str) {
  if (!str) return null;
  const match = str.match(/([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return null;
  return Number(match[1].replace(/,/g, ""));
}

function parseNewLine(rawLine) {
  if (!rawLine.trim()) return [];

  let datePart;
  let timePart;
  let rest;
  const m = rawLine.match(DATE_TIME_RE);
  if (m) {
    [, datePart, timePart, rest] = m;
  } else {
    const dm = rawLine.match(DATE_RE);
    if (!dm) return [];
    datePart = dm[1];
    rest = rawLine.slice(dm.index + dm[0].length).trim();
    const tm = rawLine.match(TIME_RE);
    timePart = tm ? tm[1] : "";
  }

  let txnType = "Dr";
  let amountStr = "";
  let splitIndex = rest.search(/\+\s+C(?=\s)/);
  if (splitIndex !== -1) {
    txnType = "Cr";
    amountStr = rest.slice(splitIndex + 3).trim();
    rest = rest.slice(0, splitIndex).trim();
  } else {
    splitIndex = rest.lastIndexOf(" C");
    if (splitIndex !== -1) {
      amountStr = rest.slice(splitIndex + 2).trim();
      rest = rest.slice(0, splitIndex).trim();
    }
  }

  const amount = cleanAmount(amountStr);
  let forexCurrency = "INR";
  let forexAmount = null;
  let description = rest;

  const forexMatch = rest.match(FOREX_RE);
  if (forexMatch && forexMatch.groups) {
    forexCurrency = forexMatch.groups.currency;
    forexAmount = cleanAmount(forexMatch.groups.amount);
    description = rest.replace(FOREX_RE, "").trim();
  }

  let forexRate = "";
  if (forexAmount && amount) {
    const computed = amount / forexAmount;
    if (Number.isFinite(computed)) {
      forexRate = computed.toFixed(4);
    }
  }

  let refNote = "";
  if (forexAmount && forexCurrency !== "INR" && forexRate) {
    refNote = `Forex: ${forexAmount} ${forexCurrency} @ ${forexRate}`;
  }

  return [
    {
      date: datePart,
      withdrawals: txnType === "Dr" ? (amount ?? "") : "",
      deposits: txnType === "Cr" ? (amount ?? "") : "",
      payee: "",
      description,
      reference_number: refNote,
    },
  ];
}

function parseOldLine(rawLine, section) {
  if (!rawLine.trim()) return [];
  // Match date anywhere near the start — some lines have junk prefixes like "null"
  const dm = rawLine.match(/(?:^|\s)(\d{2}\/\d{2}\/\d{4})\s+(.*)$/);
  if (!dm) return [];

  const datePart = dm[1];
  let rest = dm[2].trim();

  const amountMatch = rest.match(/([\d,]+(?:\.\d{1,2})?)\s*(Cr)?\s*$/i);
  if (!amountMatch) return [];

  const amountStr = amountMatch[1];
  const txnType = amountMatch[2] ? "Cr" : "Dr";
  rest = rest.slice(0, amountMatch.index).trim();

  let currency = "INR";
  let forexAmount = "";
  let forexRate = "";
  let description = rest;

  if (section === "international") {
    const forexMatch = rest.match(FOREX_RE);
    if (forexMatch && forexMatch.groups) {
      currency = forexMatch.groups.currency;
      forexAmount = cleanAmount(forexMatch.groups.amount) ?? "";
      description = rest.replace(FOREX_RE, "").trim();
      const amount = cleanAmount(amountStr);
      if (amount && forexAmount) {
        forexRate = (amount / forexAmount).toFixed(2);
      }
    }
  }

  const amount = cleanAmount(amountStr) ?? "";

  let refNote = "";
  if (forexAmount && currency !== "INR" && forexRate) {
    refNote = `Forex: ${forexAmount} ${currency} @ ${forexRate}`;
  }

  return [
    {
      date: datePart,
      withdrawals: txnType === "Dr" ? amount : "",
      deposits: txnType === "Cr" ? amount : "",
      payee: "",
      description,
      reference_number: refNote,
    },
  ];
}

async function extractLinesFromPdf(file, password) {
  const data = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data, password: password || undefined });
  const pdf = await loadingTask.promise;

  const allLines = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();

    let buffer = "";
    for (const item of textContent.items) {
      buffer += item.str;
      if (item.hasEOL) {
        allLines.push(buffer.trim());
        buffer = "";
      } else {
        buffer += " ";
      }
    }
    if (buffer.trim()) {
      allLines.push(buffer.trim());
    }
  }

  return allLines;
}

async function parseFile(file, password) {
  const lines = await extractLinesFromPdf(file, password);

  // Try old format first
  let rows = [];
  let section = "";
  for (const line of lines) {
    if (/Domestic Transactions/i.test(line)) {
      section = "domestic";
      continue;
    }
    if (/International Transactions/i.test(line)) {
      section = "international";
      continue;
    }
    if (!section) continue;
    rows.push(...parseOldLine(line, section));
  }

  let format = "old";
  if (!rows.length) {
    rows = [];
    for (const line of lines) {
      rows.push(...parseNewLine(line));
    }
    format = "new";
  }

  rows.sort((a, b) => {
    const [ad, am, ay] = a.date.split("/");
    const [bd, bm, by] = b.date.split("/");
    return new Date(ay, am - 1, ad) - new Date(by, bm - 1, bd);
  });

  return { rows, format };
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
  id: "hdfc-credit-card",
  name: "HDFC Credit Card",
  description: "Parse HDFC credit card statement PDFs into CSV",
  icon: "💳",
  accept: ".pdf,application/pdf",
  fileLabel: "statement PDF",
  needsPassword: true,
  parseFile,
  getColumns,
  isValidFile,
};
