import { describe, expect, it } from "bun:test";
import {
    DEFAULT_ITERATIONS,
    SAFE_ITERATIONS_CEILING,
    hashPassword,
    iterationsOf,
    needsRehash,
    resolveIterations,
    timingSafeEqual,
    verifyPassword,
} from "../password";

async function legacySha256(password: string): Promise<string> {
    const data = new TextEncoder().encode(password);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

describe("password utils", () => {
    it("creates salted PBKDF2 hashes that verify", async () => {
        const first = await hashPassword("correct horse", 1000);
        const second = await hashPassword("correct horse", 1000);

        expect(first.startsWith("pbkdf2$")).toBe(true);
        expect(first).not.toBe(second); // 随机盐
        expect(await verifyPassword("correct horse", first)).toBe(true);
        expect(await verifyPassword("wrong horse", first)).toBe(false);
    });

    it("rejects malformed hashes instead of throwing", async () => {
        expect(await verifyPassword("anything", "pbkdf2$abc$def")).toBe(false);
        expect(await verifyPassword("anything", "pbkdf2$1000$not base64$!!")).toBe(false);
        expect(await verifyPassword("anything", "")).toBe(false);
        expect(await verifyPassword("anything", null)).toBe(false);
    });

    it("still verifies legacy unsalted sha256 hashes", async () => {
        const legacy = await legacySha256("admin123");

        expect(await verifyPassword("admin123", legacy)).toBe(true);
        expect(await verifyPassword("admin124", legacy)).toBe(false);
    });

    it("marks legacy hashes for rehashing", async () => {
        expect(needsRehash(await legacySha256("x"))).toBe(true);
        expect(needsRehash(await hashPassword("x", 1000), 1000)).toBe(false);
        expect(needsRehash(null)).toBe(false);
    });

    it("rehashes when the configured iteration count changes", async () => {
        const stored = await hashPassword("x", 1000);

        expect(iterationsOf(stored)).toBe(1000);
        // 迭代次数与目标一致：不需要重算
        expect(needsRehash(stored, 1000)).toBe(false);
        // 目标调高或调低都会收敛到当前配置
        expect(needsRehash(stored, 20_000)).toBe(true);
        expect(needsRehash(stored, 10_000)).toBe(true);
        expect(iterationsOf("pbkdf2$abc$def")).toBe(0);
        expect(iterationsOf(null)).toBe(0);
    });

    it("keeps the default iteration count affordable for Workers' CPU budget", async () => {
        // Workers 免费计划每请求只有 10ms CPU：150k 迭代实测 30ms 以上，
        // 会把登录请求直接打成 error 1102（密码正确也登不进去）。
        expect(DEFAULT_ITERATIONS).toBeLessThanOrEqual(SAFE_ITERATIONS_CEILING);
        expect(DEFAULT_ITERATIONS).toBeLessThanOrEqual(10_000);

        const start = performance.now();
        await hashPassword("bench-password");
        expect(performance.now() - start).toBeLessThan(10_000);
    });

    it("reads the iteration count from the environment", async () => {
        expect(resolveIterations(undefined)).toBe(DEFAULT_ITERATIONS);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: "" })).toBe(DEFAULT_ITERATIONS);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: "abc" })).toBe(DEFAULT_ITERATIONS);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: "500" })).toBe(DEFAULT_ITERATIONS);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: "25000" })).toBe(25_000);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: " 12000 " })).toBe(12_000);
        expect(resolveIterations({ PASSWORD_HASH_ITERATIONS: "99999999" })).toBe(1_000_000);
    });

    it("compares byte arrays in constant time fashion", () => {
        expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
        expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
        expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    });
});
