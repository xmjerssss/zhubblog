import { path_join } from "./path";
import { buildS3ObjectUrl, createS3Client, putObject as putS3Object } from "./s3";

type StorageTarget =
  | {
      type: "r2";
      bucket: R2Bucket;
      folder: string;
      publicBaseUrl: string;
    }
  | {
      type: "s3";
      env: Env;
      folder: string;
      publicBaseUrl: string;
    };

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function resolveStorageTarget(env: Env): StorageTarget {
  const folder = env.S3_FOLDER || "";
  const publicBaseUrl = trimTrailingSlash(env.S3_ACCESS_HOST || env.S3_ENDPOINT || "");

  if (env.R2_BUCKET) {
    return {
      type: "r2",
      bucket: env.R2_BUCKET,
      folder,
      publicBaseUrl,
    };
  }

  if (!env.S3_ENDPOINT) {
    throw new Error("S3_ENDPOINT is not defined");
  }
  if (!env.S3_ACCESS_KEY_ID) {
    throw new Error("S3_ACCESS_KEY_ID is not defined");
  }
  if (!env.S3_SECRET_ACCESS_KEY) {
    throw new Error("S3_SECRET_ACCESS_KEY is not defined");
  }
  if (!env.S3_BUCKET) {
    throw new Error("S3_BUCKET is not defined");
  }

  return {
    type: "s3",
    env,
    folder,
    publicBaseUrl,
  };
}

function encodeStorageKey(key: string) {
  return key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildBlobUrl(storageKey: string, baseUrl?: string) {
  const encodedKey = encodeStorageKey(storageKey);
  const path = `/api/blob/${encodedKey}`;

  if (!baseUrl) {
    return path;
  }

  return `${trimTrailingSlash(baseUrl)}${path}`;
}

function createStorageResponse(object: R2ObjectBody | R2Object, body?: BodyInit | null, requestedRange = false) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);

  if (object.httpEtag) {
    headers.set("ETag", object.httpEtag);
  }

  let status = 200;
  const range = (object as R2ObjectBody).range as
    | { offset?: number; length?: number; suffix?: number }
    | undefined;
  if (requestedRange && range) {
    // R2 返回了部分内容，补全 206 所需的响应头，浏览器才能拖动视频进度条
    let start = 0;
    let end = object.size - 1;
    if (range.suffix !== undefined) {
      start = Math.max(0, object.size - range.suffix);
    } else {
      start = range.offset ?? 0;
      end = range.length !== undefined ? start + range.length - 1 : object.size - 1;
    }
    end = Math.min(end, object.size - 1);
    status = 206;
    headers.set("Content-Range", `bytes ${start}-${end}/${object.size}`);
    headers.set("Content-Length", String(end - start + 1));
  } else if (!headers.has("Content-Length")) {
    headers.set("Content-Length", String(object.size));
  }

  headers.set("Accept-Ranges", "bytes");

  if (!headers.has("Last-Modified")) {
    headers.set("Last-Modified", object.uploaded.toUTCString());
  }

  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }

  if (!headers.has("Access-Control-Allow-Origin")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  return new Response(body ?? null, {
    status,
    headers,
  });
}

/** 环境变量里是否配置了默认存储（R2 binding 或完整的 S3_* 变量）。 */
export function isEnvStorageConfigured(env: Env): boolean {
  if (env.R2_BUCKET) return true;
  return Boolean(env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY && env.S3_BUCKET);
}

export async function getStorageObject(
  env: Env,
  storageKey: string,
  rangeHeader?: string | null,
): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const object = rangeHeader
      ? await env.R2_BUCKET.get(storageKey, { range: new Headers({ Range: rangeHeader }) })
      : await env.R2_BUCKET.get(storageKey);
    if (!object) {
      return null;
    }
    const body = (object as R2ObjectBody).body;
    return createStorageResponse(object, body, Boolean(rangeHeader));
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "GET",
    headers: rangeHeader ? { Range: rangeHeader } : undefined,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function headStorageObject(env: Env, storageKey: string): Promise<Response | null> {
  if (env.R2_BUCKET) {
    const object = await env.R2_BUCKET.head(storageKey);
    if (!object) {
      return null;
    }
    return createStorageResponse(object);
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "HEAD",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to inspect storage object: ${response.status} ${response.statusText}`);
  }

  return response;
}

export function getStoragePublicUrl(env: Env, storageKey: string, baseUrl?: string) {
  if (env.S3_ACCESS_HOST) {
    return `${trimTrailingSlash(env.S3_ACCESS_HOST)}/${storageKey}`;
  }

  return buildBlobUrl(storageKey, baseUrl);
}

export async function putStorageObject(
  env: Env,
  key: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  const target = resolveStorageTarget(env);
  const storageKey = path_join(target.folder, key);

  return putStorageObjectAtKey(env, storageKey, body, contentType, baseUrl);
}

export async function putStorageObjectAtKey(
  env: Env,
  storageKey: string,
  body: Blob | ArrayBuffer | Uint8Array | string,
  contentType?: string,
  baseUrl?: string,
) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.put(storageKey, body, {
      httpMetadata: contentType ? { contentType } : undefined,
    });
  } else {
    const client = createS3Client(env);
    await putS3Object(client, env, storageKey, body, contentType);
  }

  return {
    key: storageKey,
    url: getStoragePublicUrl(env, storageKey, baseUrl),
  };
}

export async function deleteStorageObject(env: Env, storageKey: string) {
  if (env.R2_BUCKET) {
    await env.R2_BUCKET.delete(storageKey);
    return;
  }

  const client = createS3Client(env);
  const response = await client.fetch(buildS3ObjectUrl(env, storageKey), {
    method: "DELETE",
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Failed to delete storage object: ${response.status} ${response.statusText}`);
  }
}
