import { describe, expect, it } from "bun:test";
import { isAllowedOrigin, isTrustedFrontendUrl, parseConfiguredOrigins } from "../origin";

const context = { requestUrl: "https://blog.example.com/api/feed", frontendUrl: "" };

describe("origin utils", () => {
    it("parses comma separated FRONTEND_URL values", () => {
        expect(parseConfiguredOrigins("https://a.com, https://b.com/x")).toEqual([
            "https://a.com",
            "https://b.com",
        ]);
        expect(parseConfiguredOrigins("not a url")).toEqual([]);
        expect(parseConfiguredOrigins("")).toEqual([]);
    });

    it("allows same origin and same hostname", () => {
        expect(isAllowedOrigin("https://blog.example.com", context)).toBe(true);
        // 本地开发时前端与后端端口不同
        expect(isAllowedOrigin("http://localhost:5173", context)).toBe(true);
    });

    it("allows origins listed in FRONTEND_URL", () => {
        expect(isAllowedOrigin("https://blog.example.com", {
            requestUrl: "https://api.example.com/api/feed",
            frontendUrl: "https://blog.example.com",
        })).toBe(true);
    });

    it("rejects arbitrary third-party origins", () => {
        expect(isAllowedOrigin("https://evil.example.net", context)).toBe(false);
        expect(isAllowedOrigin("https://blog.example.com.evil.net", context)).toBe(false);
        expect(isAllowedOrigin("javascript:alert(1)", context)).toBe(false);
        expect(isAllowedOrigin(undefined, context)).toBe(false);
    });

    it("only trusts frontend urls on allowed hosts", () => {
        expect(isTrustedFrontendUrl("https://blog.example.com/callback", context)).toBe(true);
        expect(isTrustedFrontendUrl("https://evil.example.net/callback", context)).toBe(false);
        expect(isTrustedFrontendUrl("file:///etc/passwd", context)).toBe(false);
    });
});
