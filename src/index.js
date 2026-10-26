import puppeteer from "@cloudflare/puppeteer";

const FONT_SPECS = [
  {
    assetPath: "/fonts/Averta-Regular.otf",
    aliasFamily: "Averta Regular",
    family: "Averta",
    format: "opentype",
    mimeType: "font/otf",
    weight: 400,
  },
  {
    assetPath: "/fonts/Averta-Semibold.otf",
    aliasFamily: "Averta Semibold",
    family: "Averta",
    format: "opentype",
    mimeType: "font/otf",
    weight: 600,
  },
  {
    assetPath: "/fonts/Averta-Bold.otf",
    aliasFamily: "Averta Bold",
    family: "Averta",
    format: "opentype",
    mimeType: "font/otf",
    weight: 700,
  },
];

const HTML_SIZE_LIMIT_BYTES = 3_000_000;
const RENDER_TIMEOUT_MS = 40_000;
const BROWSER_KEEP_ALIVE_MS = 60_000;
const PDF_FILENAME = "document.pdf";
let embeddedFontStylePromise;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url);

    log("info", "request_started", {
      contentLength: request.headers.get("content-length"),
      method: request.method,
      path: url.pathname,
      requestId,
    });

    try {
      if (url.pathname === "/health") {
        const response = jsonResponse(
          {
            ok: true,
            service: "html2pdf",
          },
          {
            headers: {
              "x-request-id": requestId,
            },
          },
        );

        log("info", "request_succeeded", {
          method: request.method,
          path: url.pathname,
          requestId,
          status: response.status,
        });

        return response;
      }

      if (url.pathname !== "/render") {
        return env.ASSETS.fetch(request);
      }

      if (request.method !== "POST") {
        throw new HttpError(
          405,
          "method_not_allowed",
          "Use POST /render to generate a PDF.",
          { allow: "POST" },
        );
      }

      authorizeRequest(request, env);
      validateContentType(request);

      const rawHtml = await readHtmlBody(request);
      const normalizedHtml = normalizeIncomingHtml(rawHtml);
      const pdfBytes = await renderPdf({
        env,
        html: normalizedHtml,
        origin: url.origin,
        requestId,
      });

      const response = new Response(pdfBytes, {
        status: 200,
        headers: {
          "cache-control": "no-store",
          "content-disposition": `inline; filename="${PDF_FILENAME}"`,
          "content-type": "application/pdf",
          "x-request-id": requestId,
        },
      });

      log("info", "request_succeeded", {
        method: request.method,
        path: url.pathname,
        requestId,
        status: response.status,
      });

      return response;
    } catch (error) {
      const response = errorResponse(error, requestId);

      log("error", "request_failed", {
        details: error instanceof HttpError ? error.details : undefined,
        error: error instanceof Error ? error.message : String(error),
        method: request.method,
        path: url.pathname,
        requestId,
        status: response.status,
      });

      return response;
    } finally {
      log("info", "request_finished", {
        durationMs: Date.now() - startedAt,
        method: request.method,
        path: url.pathname,
        requestId,
      });
    }
  },
};

function authorizeRequest(request, env) {
  const expectedToken = env.PDF_AUTH_TOKEN?.trim();

  if (!expectedToken) {
    throw new HttpError(
      500,
      "auth_not_configured",
      "The PDF_AUTH_TOKEN secret is not configured.",
    );
  }

  const authorizationHeader = request.headers.get("authorization");

  if (!authorizationHeader) {
    throw new HttpError(
      401,
      "missing_authorization",
      "Missing Authorization header.",
    );
  }

  const [scheme, token] = authorizationHeader.split(/\s+/, 2);

  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    throw new HttpError(
      401,
      "invalid_authorization",
      "Authorization must use the Bearer scheme.",
    );
  }

  if (!safeEqual(token, expectedToken)) {
    throw new HttpError(
      401,
      "invalid_token",
      "The supplied bearer token is invalid.",
    );
  }
}

function validateContentType(request) {
  const contentType = request.headers.get("content-type");

  if (!contentType) {
    return;
  }

  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();

  if (mediaType !== "text/html") {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "The request body must be sent as text/html.",
      { contentType },
    );
  }
}

async function readHtmlBody(request) {
  const declaredContentLength = request.headers.get("content-length");

  if (declaredContentLength) {
    const declaredBytes = Number(declaredContentLength);

    if (Number.isFinite(declaredBytes) && declaredBytes > HTML_SIZE_LIMIT_BYTES) {
      throw new HttpError(
        413,
        "payload_too_large",
        `HTML payloads must be ${HTML_SIZE_LIMIT_BYTES} bytes or smaller.`,
      );
    }
  }

  if (!request.body) {
    throw new HttpError(
      400,
      "empty_body",
      "The request body must contain HTML.",
    );
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const htmlChunks = [];
  let actualBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      actualBytes += value.byteLength;

      if (actualBytes > HTML_SIZE_LIMIT_BYTES) {
        void reader.cancel().catch((error) => {
          log("warn", "request_body_cancel_failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });

        throw new HttpError(
          413,
          "payload_too_large",
          `HTML payloads must be ${HTML_SIZE_LIMIT_BYTES} bytes or smaller.`,
          { actualBytes },
        );
      }

      htmlChunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  htmlChunks.push(decoder.decode());
  const html = htmlChunks.join("");

  if (!html.trim()) {
    throw new HttpError(
      400,
      "empty_body",
      "The request body must contain HTML.",
    );
  }

  return html;
}

function normalizeIncomingHtml(html) {
  return html.replace(/\\r\\n/g, "\r\n").replace(/\\n/g, "\n");
}

async function renderPdf({ env, html, origin, requestId }) {
  const embeddedFontStyle = await buildEmbeddedFontStyle(env, origin);
  const documentHtml = injectHeadContent(
    html,
    `${embeddedFontStyle}\n${buildBasePrintStyle()}`,
  );

  let browser;

  try {
    browser = await puppeteer.launch(env.MYBROWSER, {
      keep_alive: BROWSER_KEEP_ALIVE_MS,
    });

    const page = await browser.newPage();

    page.setDefaultNavigationTimeout(RENDER_TIMEOUT_MS);
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setJavaScriptEnabled(false);
    await page.setViewport({
      deviceScaleFactor: 1,
      height: 1123,
      width: 794,
    });

    await configureRequestFiltering(page, requestId);
    await page.setContent(documentHtml, {
      waitUntil: ["domcontentloaded", "networkidle0"],
    });
    await page.emulateMediaType("print");
    await page.evaluate(async () => {
      await document.fonts.ready;

      await Promise.all(
        Array.from(document.images)
          .filter((image) => !image.complete)
          .map(
            (image) =>
              new Promise((resolve) => {
                image.addEventListener("error", resolve, { once: true });
                image.addEventListener("load", resolve, { once: true });
              }),
          ),
      );
    });

    const pdf = await page.pdf({
      format: "A4",
      margin: {
        bottom: "0",
        left: "0",
        right: "0",
        top: "0",
      },
      preferCSSPageSize: true,
      printBackground: true,
    });

    await page.close();

    return pdf;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(
      502,
      "pdf_generation_failed",
      "Chromium failed to render the supplied HTML to PDF.",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        log("warn", "browser_close_failed", {
          error:
            closeError instanceof Error
              ? closeError.message
              : String(closeError),
          requestId,
        });
      }
    }
  }
}

async function configureRequestFiltering(page, requestId) {
  await page.setRequestInterception(true);

  page.on("request", (subrequest) => {
    const targetUrl = subrequest.url();

    if (!isAllowedSubrequestUrl(targetUrl)) {
      log("warn", "blocked_subrequest", {
        requestId,
        url: targetUrl,
      });
      subrequest.abort("blockedbyclient");
      return;
    }

    subrequest.continue();
  });
}

function isAllowedSubrequestUrl(targetUrl) {
  try {
    const parsedUrl = new URL(targetUrl);

    if (
      parsedUrl.protocol === "data:" ||
      parsedUrl.protocol === "blob:" ||
      parsedUrl.protocol === "about:"
    ) {
      return true;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      return false;
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]" ||
      hostname.endsWith(".localhost")
    ) {
      return false;
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isPrivateIpv4(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

function isPrivateIpv4(hostname) {
  const octets = hostname.split(".").map(Number);

  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;

  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

async function buildEmbeddedFontStyle(env, origin) {
  if (!embeddedFontStylePromise) {
    embeddedFontStylePromise = (async () => {
      const fontFaces = await Promise.all(
        FONT_SPECS.map(async (font) => {
          const fontBytes = await loadFontAsset(env, origin, font.assetPath);
          const fontDataUrl = `data:${font.mimeType};base64,${arrayBufferToBase64(fontBytes)}`;

          return `
@font-face {
  font-family: "${font.family}";
  font-style: normal;
  font-weight: ${font.weight};
  src: url("${fontDataUrl}") format("${font.format}");
  font-display: block;
}
@font-face {
  font-family: "${font.aliasFamily}";
  font-style: normal;
  font-weight: normal;
  src: url("${fontDataUrl}") format("${font.format}");
  font-display: block;
}`;
        }),
      );

      return `<style id="embedded-averta-fonts">${fontFaces.join("\n")}</style>`;
    })().catch((error) => {
      embeddedFontStylePromise = undefined;
      throw error;
    });
  }

  return embeddedFontStylePromise;
}

async function loadFontAsset(env, origin, assetPath) {
  const assetRequest = new Request(new URL(assetPath, origin));
  const response = await env.ASSETS.fetch(assetRequest);

  if (!response.ok) {
    throw new HttpError(
      500,
      "font_asset_missing",
      `Font asset ${assetPath} could not be loaded.`,
      {
        assetPath,
        status: response.status,
      },
    );
  }

  const fontBytes = await response.arrayBuffer();

  if (fontBytes.byteLength === 0) {
    throw new HttpError(
      500,
      "font_asset_empty",
      `Font asset ${assetPath} is empty.`,
      { assetPath },
    );
  }

  return fontBytes;
}

function buildBasePrintStyle() {
  return `<style id="service-print-defaults">
@page {
  size: A4;
  margin: 0;
}

html {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

body {
  margin: 0;
}
</style>`;
}

function injectHeadContent(html, headContent) {
  if (/<head(\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${headContent}`);
  }

  if (/<html(\s[^>]*)?>/i.test(html)) {
    return html.replace(
      /<html(\s[^>]*)?>/i,
      (match) => `${match}\n<head>\n${headContent}\n</head>`,
    );
  }

  return `<!DOCTYPE html>
<html>
  <head>
    ${headContent}
  </head>
  <body>
    ${html}
  </body>
</html>`;
}

function arrayBufferToBase64(arrayBuffer) {
  return Buffer.from(arrayBuffer).toString("base64");
}

function safeEqual(left, right) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length === rightBytes.length ? 0 : 1;

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return mismatch === 0;
}

function errorResponse(error, requestId) {
  if (error instanceof HttpError) {
    return jsonResponse(
      {
        error: {
          code: error.code,
          details: error.details,
          message: error.message,
        },
      },
      {
        headers: {
          ...(error.status === 401
            ? { "www-authenticate": 'Bearer realm="html2pdf"' }
            : {}),
          ...(error.status === 405 && error.details?.allow
            ? { allow: error.details.allow }
            : {}),
          "x-request-id": requestId,
        },
        status: error.status,
      },
    );
  }

  return jsonResponse(
    {
      error: {
        code: "internal_error",
        message: "An unexpected error occurred while generating the PDF.",
      },
    },
    {
      headers: {
        "x-request-id": requestId,
      },
      status: 500,
    },
  );
}

function jsonResponse(payload, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers,
  });
}

function log(level, event, details) {
  const logger =
    level === "error" ? console.error : level === "warn" ? console.warn : console.log;

  logger(
    JSON.stringify({
      event,
      level,
      ...details,
    }),
  );
}
