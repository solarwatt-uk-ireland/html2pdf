import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";

function createEnv(overrides = {}) {
  return {
    ASSETS: {
      fetch: async () => new Response("Not Found", { status: 404 }),
    },
    PDF_AUTH_TOKEN: "top-secret-token",
    ...overrides,
  };
}

test("GET /health returns service status", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/health"),
    createEnv(),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");

  const payload = await response.json();
  assert.deepEqual(payload, {
    ok: true,
    service: "html2pdf",
  });
});

test("POST /render requires bearer authorization", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "<html><body>Hello</body></html>",
      headers: {
        "content-type": "text/html; charset=utf-8",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), 'Bearer realm="html2pdf"');

  const payload = await response.json();
  assert.equal(payload.error.code, "missing_authorization");
});

test("POST /render rejects non-HTML content types", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "<html><body>Hello</body></html>",
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "application/json",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 415);

  const payload = await response.json();
  assert.equal(payload.error.code, "unsupported_media_type");
});

test("POST /render only accepts the text/html media type", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "<html><body>Hello</body></html>",
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "application/text/html",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 415);

  const payload = await response.json();
  assert.equal(payload.error.code, "unsupported_media_type");
});

test("POST /render rejects empty HTML bodies", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "   ",
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "text/html",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 400);

  const payload = await response.json();
  assert.equal(payload.error.code, "empty_body");
});

test("POST /render enforces the size limit using streamed UTF-8 bytes", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "é".repeat(1_500_001),
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "text/html",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 413);

  const payload = await response.json();
  assert.equal(payload.error.code, "payload_too_large");
  assert.equal(payload.error.details.actualBytes, 3_000_002);
});

test("non-POST requests to /render are rejected", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      headers: {
        authorization: "Bearer top-secret-token",
      },
      method: "GET",
    }),
    createEnv(),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");

  const payload = await response.json();
  assert.equal(payload.error.code, "method_not_allowed");
});

test("POST /render fails when Averta font assets are missing", async () => {
  const response = await worker.fetch(
    new Request("https://example.com/render", {
      body: "<html><body>Hello</body></html>",
      headers: {
        authorization: "Bearer top-secret-token",
        "content-type": "text/html",
      },
      method: "POST",
    }),
    createEnv(),
  );

  assert.equal(response.status, 500);

  const payload = await response.json();
  assert.equal(payload.error.code, "font_asset_missing");
});
