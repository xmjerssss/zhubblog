import {
    SignJWT,
    jwtVerify,
    type JWTPayload,
    type KeyLike
} from 'jose'

export const JWT_ALG = 'HS256'
export const JWT_ISSUER = 'rin'
export const JWT_AUDIENCE = 'rin-client'
/** 默认令牌有效期。可通过 createJWT 的第二个参数覆盖。 */
export const JWT_DEFAULT_TTL = '7d'

export interface JWTPayloadSpec {
    iss?: string
    sub?: string
    aud?: string | string[]
    jti?: string
    nbf?: number
    exp?: number
    iat?: number
}

export interface JWTUtils {
    sign: (payload: any) => Promise<string>;
    verify: (jwt?: string) => Promise<any | false>;
}

export function createJWT(
    secret: string | Uint8Array | KeyLike,
    ttl: string = JWT_DEFAULT_TTL,
): JWTUtils {
    if (!secret) throw new Error("Secret can't be empty");

    const key = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;

    return {
        sign: async (payload: any) => {
            const jwt = new SignJWT(payload)
                .setProtectedHeader({ alg: JWT_ALG })
                .setIssuedAt();

            // 调用方显式给了 exp（例如短时效的上传令牌）就尊重它，否则套用默认有效期。
            if (!payload || typeof payload.exp !== 'number') {
                jwt.setExpirationTime(ttl);
            }

            return jwt
                .setIssuer(JWT_ISSUER)
                .setAudience(JWT_AUDIENCE)
                .sign(key);
        },
        verify: async (jwt?: string): Promise<any | false> => {
            if (!jwt) return false;

            try {
                const { payload } = await jwtVerify(jwt, key, {
                    algorithms: [JWT_ALG],
                    issuer: JWT_ISSUER,
                    audience: JWT_AUDIENCE,
                    clockTolerance: 30,
                });
                return payload as JWTPayload;
            } catch (_) {
                return false;
            }
        }
    };
}

export default createJWT;
