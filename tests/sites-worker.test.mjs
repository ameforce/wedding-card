import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../worker/index.js";

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive, nosnippet, noimageindex");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
}

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/" ? "<!-- WEDDING_PUBLIC_BOOTSTRAP -->app" : "missing", {
            status: url.pathname === "/" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.equal(response.headers.get("x-wedding-content-source"), "bundled-fallback");
  assert.match(await response.text(), /id="wedding-public-bootstrap"/);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/"]);
});

test("serves canonical admin SPA shells before Static Assets can canonicalize the route", async () => {
  for (const path of ["/admin", "/admin/guestbook"]) {
    for (const method of ["GET", "HEAD"]) {
      const calls = [];
      const response = await worker.fetch(
        new Request(`https://example.test${path}`, {
          method,
          headers: { accept: "text/html" },
        }),
        {
          ASSETS: {
            fetch: async (request) => {
              const url = new URL(request.url);
              calls.push(url.pathname);
              return new Response(url.pathname === "/" ? "admin app" : null, {
                status: url.pathname === "/" ? 200 : 308,
                headers: url.pathname === "/" ? undefined : { location: "/" },
              });
            },
          },
        },
      );

      assert.equal(response.status, 200);
      assertSecurityHeaders(response);
      assert.deepEqual(calls, ["/"]);
    }
  }
});

test("keeps the legacy content admin shell available as a rollback-safe first stage", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/admin/content?source=bookmark", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          calls.push(new URL(request.url).pathname);
          return new Response("admin app");
        },
      },
      ADMIN_CONTENT_REDIRECT_ENABLED: "false",
    },
  );

  assert.equal(response.status, 200);
  assertSecurityHeaders(response);
  assert.deepEqual(calls, ["/"]);
});

test("permanently redirects the legacy content admin route after staged activation and preserves its query", async () => {
  for (const method of ["GET", "HEAD"]) {
    let calls = 0;
    const response = await worker.fetch(
      new Request("https://example.test/admin/content?source=bookmark", { method }),
      {
        ASSETS: {
          fetch: async () => {
            calls += 1;
            return new Response("unexpected", { status: 500 });
          },
        },
        ADMIN_CONTENT_REDIRECT_ENABLED: "true",
      },
    );

    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), "https://example.test/admin?source=bookmark");
    assertSecurityHeaders(response);
    assert.equal(calls, 0);
  }
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
    new Request("https://example.test/admin/content", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("routes protected admin pages through the Worker SPA fallback", async () => {
  const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(wrangler.assets.run_worker_first, true);
  assert.equal(wrangler.version_metadata.binding, "CF_VERSION_METADATA");
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  assert.match(await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8"), /WEDDING_PUBLIC_BOOTSTRAP/);
  const staticHeaders = await readFile(new URL("../dist/client/_headers", import.meta.url), "utf8");
  assert.match(staticHeaders, /X-Robots-Tag:\s*noindex, nofollow, noarchive, nosnippet, noimageindex/);
  assert.match(staticHeaders, /Content-Security-Policy:.*frame-ancestors 'self'/);
  assert.match(staticHeaders, /X-Frame-Options:\s*SAMEORIGIN/);
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0001_guestbook.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0002_guestbook_name_lookup.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0003_invitation_content.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0004_invitation_media_quota.sql", import.meta.url));
  await access(new URL("../dist/.openai/drizzle/0005_guestbook_auth_backoff.sql", import.meta.url));
  const hosting = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "GUESTBOOK_DB");
  assert.equal(hosting.r2, "WEDDING_MEDIA");
});
