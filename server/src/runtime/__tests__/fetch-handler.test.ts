import { afterEach, describe, expect, it, mock } from "bun:test";

const getAppFetch = mock();

mock.module("../app-instance", () => ({
  getApp: () => ({
    fetch: getAppFetch,
  }),
}));

describe("handleFetch", () => {
  afterEach(() => {
    getAppFetch.mockReset();
  });

  it("serves static assets directly when the asset exists", async () => {
    getAppFetch.mockResolvedValue(new Response("app-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 200 }));

    const response = await handleFetch(
      new Request("http://localhost/assets/app.js"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(await response.text()).toBe("asset-body");
    expect(assetFetch).toHaveBeenCalledTimes(1);
    expect(getAppFetch).toHaveBeenCalledTimes(0);
  });

  it("routes /api/blob requests to the app before static assets", async () => {
    getAppFetch.mockResolvedValue(new Response("blob-body", { status: 200 }));

    const { handleFetch } = await import("../fetch-handler");
    const assetFetch = mock(async () => new Response("asset-body", { status: 404 }));

    const executionContext = {} as ExecutionContext;
    const response = await handleFetch(
      new Request("http://localhost/api/blob/images/test.txt"),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
      executionContext,
    );

    expect(await response.text()).toBe("blob-body");
    expect(getAppFetch).toHaveBeenCalledTimes(1);
    expect(assetFetch).toHaveBeenCalledTimes(0);
    expect(new URL(getAppFetch.mock.calls[0][0].url).pathname).toBe("/blob/images/test.txt");
    expect(getAppFetch.mock.calls[0][2]).toBe(executionContext);
  });

  it("returns a real 404 for a missing asset instead of the SPA shell", async () => {
    const { handleFetch } = await import("../fetch-handler");
    const indexFetch = mock(async () => new Response("<!doctype html>", { status: 200 }));
    const assetFetch = mock(async (request: Request) => {
      return new URL(request.url).pathname === "/"
        ? indexFetch()
        : new Response("not found", { status: 404 });
    });

    const response = await handleFetch(
      new Request("http://localhost/assets/writing-abc123.js", {
        headers: { accept: "*/*" },
      }),
      {
        ASSETS: {
          fetch: assetFetch,
        },
      } as unknown as Env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("doctype");
    expect(indexFetch).toHaveBeenCalledTimes(0);
  });

  it("serves the SPA shell for navigation requests", async () => {
    const { handleFetch } = await import("../fetch-handler");

    const response = await handleFetch(
      new Request("http://localhost/writing", {
        headers: { accept: "text/html,application/xhtml+xml", "sec-fetch-mode": "navigate" },
      }),
      {
        ASSETS: {
          fetch: async (request: Request) =>
            new URL(request.url).pathname === "/"
              ? new Response("<!doctype html>", { status: 200 })
              : new Response("not found", { status: 404 }),
        },
      } as unknown as Env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("doctype");
    expect(response.headers.get("cache-control")).toBe("no-cache, must-revalidate");
  });

  it("does not hand the SPA shell to non-navigation requests", async () => {
    const { handleFetch } = await import("../fetch-handler");
    let assetFetches = 0;

    const response = await handleFetch(
      new Request("http://localhost/unknown-endpoint", {
        headers: { accept: "application/json" },
      }),
      {
        ASSETS: {
          fetch: async () => {
            assetFetches += 1;
            return new Response("<!doctype html>", { status: 200 });
          },
        },
      } as unknown as Env,
    );

    expect(response.status).toBe(404);
    expect(assetFetches).toBe(0);
  });

  it("marks hashed assets as long-lived immutable", async () => {
    const { handleFetch } = await import("../fetch-handler");

    const response = await handleFetch(
      new Request("http://localhost/assets/index-abc12345.js"),
      {
        ASSETS: {
          fetch: async () =>
            new Response("console.log(1)", {
              status: 200,
              headers: { "content-type": "text/javascript" },
            }),
        },
      } as unknown as Env,
    );

    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
