import { describe, expect, it } from "bun:test";
import { hashPassword, needsRehash, timingSafeEqual, verifyPassword } from "../password";

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
        expect(needsRehash(await hashPassword("x", 1000))).toBe(false);
        expect(needsRehash(null)).toBe(false);
    });

    it("compares byte arrays in constant time fashion", () => {
        expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
        expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
        expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
    });
});
