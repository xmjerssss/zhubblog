import { cors } from "hono/cors";
import { timing } from "hono/timing";
import { authMiddleware, initContainerMiddleware } from "./hono-middleware";
import type { RinApp } from "./app-types";
import { isAllowedOrigin } from "../utils/origin";

export function registerMiddlewares(app: RinApp) {
  app.use(
    "*",
    cors({
      // 只反射白名单内的来源，避免任意站点携带 cookie 读写用户数据。
      origin: (origin, c) => {
        const allowed = isAllowedOrigin(origin, {
          requestUrl: c.req.url,
          frontendUrl: c.env?.FRONTEND_URL,
        });
        return allowed ? origin : undefined;
      },
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      allowHeaders: ["content-type", "authorization", "x-csrf-token"],
      maxAge: 600,
      credentials: true,
    }),
  );

  app.use("*", timing({ totalDescription: "" }));
  app.use("*", initContainerMiddleware);
  app.use("*", authMiddleware);
}
