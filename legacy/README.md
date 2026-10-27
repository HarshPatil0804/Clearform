# Clearform

Clearform is a static, browser-only unstructured data cleaner. It has no application server, API, database, or file upload endpoint. Parsing, normalization, pivoting, and downloads run in the browser.

## Run it

Open `index.html` in a modern browser while connected to the internet. The app loads SheetJS, PDF.js, Tesseract.js, Mammoth, and optional web fonts from CDNs. The browser stores the selected file and cleaned dataset only in the current page session; refreshing or closing the page clears them.

## Current formats

- CSV and TSV, with quoted-field parsing and delimiter detection
- TXT and LOG, including simple key/value records
- JSON and JSONL, including nested object flattening
- XLSX and XLS, with a sheet selector
- PDF text extraction across all pages
- DOCX text and the first detected table
- HTML text and HTML tables, with a table selector when tables are present
- PNG, JPG/JPEG, WEBP, and BMP through browser-side English OCR

Unsupported formats are reported clearly. Password-protected or damaged files may not parse. Scanned PDFs are detected as having no selectable text; OCR is available for image files but not embedded directly for PDF pages. DOCX extraction selects the first table when one is found. PDF pages are processed together. OCR downloads the English language model from the Tesseract CDN. Text extraction and OCR use heuristics and can require the user to review the preview before relying on the result.

## Workflow

1. Select a file and, for workbooks or HTML with tables, choose the source sheet/table.
2. Run extraction and cleaning. The result view and pivot controls stay unavailable until cleaning completes.
3. Review the cleaning summary, schema, and preview. Select normal tabular output or configure a pivot with one or more row and column dimensions.
4. Download normal data as CSV, XLSX, or JSON; pivot data as CSV or XLSX.

Pivot Sum, Mean, Minimum, and Maximum require a numeric field. Count accepts any field. Empty intersections are exported as zero. The expanded preview is capped at 5,000 rows to keep the page responsive; downloads include the full result.
