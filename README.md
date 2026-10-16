# Statement Tools

A collection of browser-based tools to parse bank and card statements into CSV.

## Open App

- https://statement-parser.midlajc.dev/

## Available Tools

### HDFC Credit Card

Parse HDFC credit card statement PDFs into CSV.

- Old and new statement layouts (auto-detected)
- Password-protected PDFs (asks for password)
- Domestic and international transactions
- Forex conversion details in reference column

### HDFC Bank Account

Parse HDFC bank account statement Excel files (.xls/.xlsx) into CSV.

- Auto-detects header row in the spreadsheet
- Supports 2-digit and 4-digit year date formats

### HDFC Bank Account

Parse HDFC bank account statement PDFs into CSV.

- Classic statement and net banking export layouts (auto-detected from the column headers)
- Password-protected PDFs (asks for password)
- Multi-line narrations merged into a single row
- Transaction time column when the statement includes it
- Withdrawal/deposit columns cross-checked against the running balance

## Unified CSV Output

All tools produce a consistent CSV format:

| Column | Description |
|---|---|
| Date | Transaction date |
| Withdrawals | Debit amount |
| Deposits | Credit amount |
| Payee | Payee name (when available) |
| Description | Transaction description / narration |
| Reference Number | Reference number or forex details |

## How To Use

1. Open the app and select a tool from the home screen.
2. Upload your file(s) using drag-and-drop or file picker.
3. If prompted, enter the PDF password.
4. Wait for parsing to complete.
5. Download the generated CSV or preview it in the app.

## PWA Features

- Installable on mobile and desktop
- Share PDF to app on supported mobile browsers
- macOS desktop file open support
- Offline app shell support after first load

## Privacy

All processing happens locally in your browser. Files are never uploaded to any server.

## Adding a New Parser

1. Create `parsers/your-parser.js` exporting: `id`, `name`, `description`, `icon`, `accept`, `fileLabel`, `needsPassword`, `parseFile`, `getColumns`, `isValidFile`.
2. Import and add it to the `tools` array in `app.js`.
3. Add the file path to `APP_SHELL` in `service-worker.js`.

## Notes

- Parsing is heuristic and depends on statement layout.
- Transactions are sorted by date in the output.
- If you update/reinstall the PWA, relaunch the app before testing share/open flows.
