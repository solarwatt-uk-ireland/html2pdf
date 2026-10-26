# html2pdf Worker

This project exposes an authenticated Cloudflare Worker endpoint that converts raw `text/html` request bodies into A4 PDF files using Cloudflare Browser Rendering.

## What it does

- Accepts `POST /render` with an HTML document in the request body.
- Limits HTML request bodies to 3 MB, enforcing the limit as the body is read.
- Requires `Authorization: Bearer <token>`.
- Normalizes literal `\n` sequences into actual line breaks before rendering.
- Embeds the uploaded Averta OTF files directly into the rendered document so the generated PDF carries the fonts with it.
- Returns the generated PDF as `application/pdf`.

## Required Averta font files

Upload these files into `public/fonts`:

- `Averta-Regular.otf`
- `Averta-Semibold.otf`
- `Averta-Bold.otf`

The Worker expects those exact filenames.

## Local setup

1. Install dependencies:
   `npm install`
2. Copy `.dev.vars.example` to `.dev.vars` and set `PDF_AUTH_TOKEN`.
3. Install Wrangler if it is not already available in your environment:
   `npm install -D wrangler`
4. Start the Worker:
   `npm run dev`

## Cloudflare configuration

1. Add the Browser Rendering binding declared in `wrangler.jsonc`:
   `MYBROWSER`
2. Set the bearer token secret:
   `npx wrangler secret put PDF_AUTH_TOKEN`
3. Deploy:
   `npm run deploy`

## Example request

PowerShell:

```powershell
$token = "replace-with-your-token"
$html = Get-Content -Raw .\sample.html

Invoke-WebRequest `
  -Method Post `
  -Uri "http://127.0.0.1:8787/render" `
  -Headers @{ Authorization = "Bearer $token"; "Content-Type" = "text/html; charset=utf-8" } `
  -Body $html `
  -OutFile .\output.pdf
```

## Responses

- `200` with a PDF body when rendering succeeds.
- `400` for empty HTML.
- `401` for missing or invalid bearer tokens.
- `405` for non-`POST` requests to `/render`.
- `413` for oversized HTML payloads.
- `415` for unsupported content types.
- `500` when configuration or font assets are missing.
- `502` when Chromium cannot render the supplied HTML.
