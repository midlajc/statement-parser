import hdfcCreditCard from "./parsers/hdfc-credit-card.js";
import hdfcBank from "./parsers/hdfc-bank.js";
import hdfcBankPdf from "./parsers/hdfc-bank-pdf.js";
import rblBank from "./parsers/rbl-bank.js";

/* ── Tool registry ── */

const tools = [hdfcCreditCard, hdfcBank, hdfcBankPdf, rblBank];

let activeTool = null;

/* ── DOM refs ── */

const homeView = document.getElementById("home-view");
const toolView = document.getElementById("tool-view");
const toolGrid = document.getElementById("tool-grid");
const toolCardTemplate = document.getElementById("tool-card-template");
const backBtn = document.getElementById("back-btn");
const toolTitle = document.getElementById("tool-title");
const toolDescription = document.getElementById("tool-description");
const dropzone = document.getElementById("dropzone");
const dropzoneIcon = dropzone.querySelector(".dropzone-icon");
const dropzoneTitle = dropzone.querySelector(".dropzone-title");
const dropzoneSubtitle = dropzone.querySelector(".dropzone-subtitle");
const fileInput = document.getElementById("file-input");
const fileList = document.getElementById("file-list");
const tileTemplate = document.getElementById("file-tile-template");
const sharedStatus = document.getElementById("shared-status");

const PAGE_SIZE = 20;

/* ── Navigation ── */

function showHome() {
  activeTool = null;
  toolView.hidden = true;
  homeView.hidden = false;
  fileList.innerHTML = "";
  document.title = "Statement Tools";
  const base = window.location.pathname + window.location.search;
  window.history.pushState(null, "", base);
}

function showTool(tool) {
  activeTool = tool;
  homeView.hidden = true;
  toolView.hidden = false;
  fileList.innerHTML = "";
  toolTitle.textContent = tool.name;
  toolDescription.textContent = tool.description;
  fileInput.setAttribute("accept", tool.accept);

  // Update dropzone text based on tool
  const isExcel = tool.accept.includes(".xls");
  dropzoneIcon.textContent = isExcel ? "XLS" : "PDF";
  dropzoneTitle.textContent = `Drop your ${tool.fileLabel} here`;
  dropzoneSubtitle.textContent = "or click to choose files";

  document.title = `${tool.name} — Statement Tools`;
  const base = window.location.pathname + window.location.search;
  window.history.pushState(null, "", `${base}#${tool.id}`);
}

backBtn.addEventListener("click", showHome);

window.addEventListener("popstate", () => {
  const hash = window.location.hash.slice(1);
  if (hash) {
    const tool = tools.find((t) => t.id === hash);
    if (tool) {
      showTool(tool);
      return;
    }
  }
  showHome();
});

/* ── Build tool cards ── */

// ".xls,.xlsx,application/vnd.ms-excel" -> ["XLS", "XLSX"]
function getFileFormats(tool) {
  return tool.accept
    .split(",")
    .map((type) => type.trim())
    .filter((type) => type.startsWith("."))
    .map((ext) => ext.slice(1).toUpperCase());
}

function renderToolGrid() {
  toolGrid.innerHTML = "";
  for (const tool of tools) {
    const node = toolCardTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".tool-card-icon").textContent = tool.icon;
    node.querySelector(".tool-card-name").textContent = tool.name;
    node.querySelector(".tool-card-description").textContent = tool.description;
    const chips = node.querySelector(".tool-card-chips");
    for (const format of getFileFormats(tool)) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = format;
      chips.appendChild(chip);
    }
    node.addEventListener("click", () => showTool(tool));
    toolGrid.appendChild(node);
  }
}

renderToolGrid();

/* ── Shared helpers ── */

function rowsToCsv(rows, columns) {
  const escapeCell = (value) => {
    const cell = value === null || value === undefined ? "" : String(value);
    return `"${cell.replace(/"/g, '""')}"`;
  };

  const lines = [columns.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row[col] ?? "")).join(","));
  }
  return lines.join("\n");
}

function renderCsvTable(container, rows, columns) {
  container.innerHTML = "";
  const tableScroll = document.createElement("div");
  tableScroll.className = "csv-table-scroll";
  const table = document.createElement("table");
  table.className = "csv-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    columns.forEach((col) => {
      const td = document.createElement("td");
      td.textContent = row[col] ?? "";
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableScroll.appendChild(table);
  container.appendChild(tableScroll);
}

/* ── File tile ── */

function createTile(file) {
  const tool = activeTool;
  if (!tool) return;

  const node = tileTemplate.content.firstElementChild.cloneNode(true);
  const nameEl = node.querySelector(".file-name");
  const statusEl = node.querySelector(".file-status");
  const removeBtn = node.querySelector(".file-remove");
  const downloadLink = node.querySelector(".download-link");
  const passwordBox = node.querySelector(".password-inline");
  const passwordInput = passwordBox.querySelector("input");
  const passwordSubmit = node.querySelector(".password-submit");
  const previewPanel = node.querySelector(".preview-panel");
  const previewClose = node.querySelector(".preview-close");
  const previewPdfBtn = node.querySelector(".preview-pdf-btn");
  const previewCsvBtn = node.querySelector(".preview-csv-btn");
  const previewPdf = node.querySelector(".preview-pdf-view");
  const previewCsv = node.querySelector(".preview-csv-view");

  // Rename preview button for non-PDF tools
  const isPdf = tool.accept.includes("pdf");
  previewPdfBtn.textContent = isPdf ? "Preview PDF" : "Preview File";

  let csvUrl = null;
  let fileUrl = null;
  let parsedRows = null;
  let parsedColumns = null;
  let currentPage = 1;

  const setStatus = (message) => {
    statusEl.textContent = message;
  };

  const cleanup = () => {
    if (csvUrl) {
      URL.revokeObjectURL(csvUrl);
      csvUrl = null;
    }
    if (fileUrl) {
      URL.revokeObjectURL(fileUrl);
      fileUrl = null;
    }
    node.remove();
  };

  const showPreviewPanel = () => {
    previewPanel.hidden = false;
  };

  const hidePreviewPanel = () => {
    previewPanel.hidden = true;
    previewPdf.hidden = true;
    previewCsv.hidden = true;
  };

  const renderFilePreview = () => {
    previewPdf.innerHTML = "";
    if (isPdf) {
      const iframe = document.createElement("iframe");
      iframe.src = fileUrl;
      previewPdf.appendChild(iframe);
    } else {
      const msg = document.createElement("p");
      msg.className = "csv-note";
      msg.textContent = "File preview is not available for this format. Use CSV preview instead.";
      previewPdf.appendChild(msg);
    }
  };

  const renderCsvPreviewIfReady = () => {
    previewCsv.innerHTML = "";
    if (!parsedRows || !parsedColumns) {
      const msg = document.createElement("p");
      msg.className = "csv-note";
      msg.textContent = "Parse the statement to preview CSV.";
      previewCsv.appendChild(msg);
      return;
    }
    const totalPages = Math.max(1, Math.ceil(parsedRows.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = Math.min(start + PAGE_SIZE, parsedRows.length);
    const previewRows = parsedRows.slice(start, end);

    renderCsvTable(previewCsv, previewRows, parsedColumns);

    const pagination = document.createElement("div");
    pagination.className = "csv-pagination";

    const info = document.createElement("span");
    info.className = "page-info";
    info.textContent = `Page ${currentPage} of ${totalPages} \u2014 rows ${start + 1}-${end} of ${parsedRows.length}`;

    const controls = document.createElement("div");
    controls.className = "page-controls";

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "ghost";
    prevBtn.textContent = "Previous";
    prevBtn.disabled = currentPage === 1;
    prevBtn.addEventListener("click", () => {
      currentPage = Math.max(1, currentPage - 1);
      renderCsvPreviewIfReady();
    });

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "ghost";
    nextBtn.textContent = "Next";
    nextBtn.disabled = currentPage === totalPages;
    nextBtn.addEventListener("click", () => {
      currentPage = Math.min(totalPages, currentPage + 1);
      renderCsvPreviewIfReady();
    });

    controls.appendChild(prevBtn);
    controls.appendChild(nextBtn);
    pagination.appendChild(info);
    pagination.appendChild(controls);
    previewCsv.appendChild(pagination);
  };

  const runParse = async () => {
    downloadLink.hidden = true;
    passwordBox.hidden = true;
    previewPdfBtn.hidden = true;
    previewCsvBtn.hidden = true;
    setStatus("Parsing...");

    try {
      const password = tool.needsPassword ? passwordInput.value.trim() : undefined;
      const { rows, format } = await tool.parseFile(file, password);

      if (!rows.length) {
        setStatus("No transactions detected. The file may use a different layout.");
        return;
      }

      const columns = tool.getColumns(format);
      const csv = rowsToCsv(rows, columns);
      const blob = new Blob([csv], { type: "text/csv" });

      if (csvUrl) {
        URL.revokeObjectURL(csvUrl);
      }
      csvUrl = URL.createObjectURL(blob);

      downloadLink.href = csvUrl;
      downloadLink.download = file.name.replace(/\.[^.]+$/, "") + ".csv";
      downloadLink.hidden = false;

      parsedRows = rows;
      parsedColumns = columns;
      currentPage = 1;
      previewPdfBtn.hidden = !isPdf;
      previewCsvBtn.hidden = false;
      setStatus(`Parsed ${rows.length} transactions.`);
    } catch (err) {
      if (err?.name === "PasswordException") {
        passwordBox.hidden = false;
        previewPdfBtn.hidden = true;
        previewCsvBtn.hidden = true;
        setStatus("Password required to open this PDF.");
      } else {
        setStatus(`Failed to parse: ${err.message || err}`);
      }
    }
  };

  nameEl.textContent = file.name;
  setStatus("Parsing...");
  fileUrl = URL.createObjectURL(file);

  removeBtn.addEventListener("click", cleanup);
  passwordSubmit.addEventListener("click", runParse);
  previewClose.addEventListener("click", hidePreviewPanel);

  previewPdfBtn.addEventListener("click", () => {
    showPreviewPanel();
    previewCsv.hidden = true;
    previewPdf.hidden = false;
    renderFilePreview();
  });

  previewCsvBtn.addEventListener("click", () => {
    showPreviewPanel();
    previewPdf.hidden = true;
    previewCsv.hidden = false;
    renderCsvPreviewIfReady();
  });

  fileList.appendChild(node);
  runParse();
}

function acceptFiles(fileListLike) {
  const tool = activeTool;
  if (!tool) return;
  const files = Array.from(fileListLike);
  files.forEach((file) => {
    if (!tool.isValidFile(file)) return;
    createTile(file);
  });
}

/* ── Shared status helpers ── */

function setSharedStatus(message, isError = false) {
  if (!sharedStatus) return;
  if (!message) {
    sharedStatus.textContent = "";
    sharedStatus.hidden = true;
    sharedStatus.classList.remove("is-error");
    return;
  }
  sharedStatus.textContent = message;
  sharedStatus.hidden = false;
  sharedStatus.classList.toggle("is-error", isError);
}

function clearSharedUrlParams() {
  const url = new URL(window.location.href);
  url.searchParams.delete("shared");
  window.history.replaceState({}, "", url);
}

/* ── PWA / Service worker ── */

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/service-worker.js");
  } catch (err) {
    console.error("Service worker registration failed:", err);
  }
}

function registerFileLaunchConsumer() {
  if (!("launchQueue" in window) || typeof window.launchQueue.setConsumer !== "function") return;

  window.launchQueue.setConsumer(async (launchParams) => {
    if (!launchParams?.files?.length) return;

    try {
      const openedFiles = [];
      for (const fileHandle of launchParams.files) {
        if (!fileHandle || typeof fileHandle.getFile !== "function") continue;
        const file = await fileHandle.getFile();
        openedFiles.push(file);
      }

      if (openedFiles.length) {
        if (!activeTool) showTool(tools[0]);
        acceptFiles(openedFiles);
        setSharedStatus(
          `Imported ${openedFiles.length} file${openedFiles.length === 1 ? "" : "s"} from file open.`,
        );
      } else {
        setSharedStatus("No file was provided from file open.", true);
      }
    } catch (err) {
      setSharedStatus("Could not open file from the system handler.", true);
      console.error("File handler import failed:", err);
    }
  });
}

async function waitForServiceWorkerControl(timeoutMs = 5000) {
  if (navigator.serviceWorker.controller) return;

  await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for service worker")), timeoutMs);
    }),
  ]);

  if (!navigator.serviceWorker.controller) {
    throw new Error("Current page is not controlled by service worker");
  }
}

async function importSharedFilesIfAny() {
  const url = new URL(window.location.href);
  const sharedState = url.searchParams.get("shared");
  let importedCount = 0;

  if (!sharedState) return;

  if (!activeTool) showTool(tools[0]);

  if (sharedState === "empty") {
    setSharedStatus("Share target did not include a file.", true);
    clearSharedUrlParams();
    return;
  }

  if (!("serviceWorker" in navigator)) {
    setSharedStatus("Shared import needs service worker support.", true);
    clearSharedUrlParams();
    return;
  }

  try {
    await waitForServiceWorkerControl();
    const pendingResponse = await fetch("/shared-files/pending", { cache: "no-store" });

    if (pendingResponse.status === 204) {
      setSharedStatus("No shared file is pending. Upload a file manually.");
      clearSharedUrlParams();
      return;
    }

    if (!pendingResponse.ok) {
      throw new Error(`Pending request failed with status ${pendingResponse.status}`);
    }

    const pending = await pendingResponse.json();
    const sharedFiles = [];

    for (const meta of pending.files || []) {
      if (!meta?.url) continue;
      const fileResponse = await fetch(meta.url, { cache: "no-store" });
      if (!fileResponse.ok) continue;
      const blob = await fileResponse.blob();
      sharedFiles.push(
        new File([blob], meta.name || "statement.pdf", {
          type: meta.type || blob.type || "application/pdf",
          lastModified: Date.now(),
        }),
      );
    }

    if (sharedFiles.length) {
      acceptFiles(sharedFiles);
      importedCount = sharedFiles.length;
      setSharedStatus(
        `Imported ${sharedFiles.length} file${sharedFiles.length === 1 ? "" : "s"} from share target.`,
      );
    } else {
      setSharedStatus("No valid file was found in shared data.", true);
    }

    try {
      if (pending.id) {
        await fetch(`/shared-files/consume?id=${encodeURIComponent(pending.id)}`, {
          cache: "no-store",
        });
      } else {
        await fetch("/shared-files/consume", { cache: "no-store" });
      }
    } catch (consumeErr) {
      console.warn("Shared cleanup failed:", consumeErr);
    }
  } catch (err) {
    if (!importedCount) {
      setSharedStatus("Could not import shared file. You can still upload manually.", true);
    }
    console.error("Shared import failed:", err);
  } finally {
    clearSharedUrlParams();
  }
}

/* ── Init ── */

registerServiceWorker();
registerFileLaunchConsumer();
importSharedFilesIfAny();

// Deep-link: if URL has a tool hash, open it directly
const initialHash = window.location.hash.slice(1);
if (initialHash) {
  const tool = tools.find((t) => t.id === initialHash);
  if (tool) showTool(tool);
}

/* ── Dropzone events ── */

fileInput.addEventListener("change", (event) => {
  acceptFiles(event.target.files);
  fileInput.value = "";
});

dropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropzone.classList.add("is-dragging");
});

dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("is-dragging");
});

dropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropzone.classList.remove("is-dragging");
  acceptFiles(event.dataTransfer.files);
});

dropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
