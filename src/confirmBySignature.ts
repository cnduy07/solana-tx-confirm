import type {
    GetBlockHeightConfig,
    Commitment,
    TransactionSignature,
    SignatureStatusConfig,
    RpcResponseAndContext,
    SignatureStatus
} from "@solana/web3.js";

export interface SignatureConfirmer {
    getSignatureStatuses(signatures: Array<TransactionSignature>, config?: SignatureStatusConfig): Promise<RpcResponseAndContext<Array<SignatureStatus | null>>>;
    getBlockHeight(commitmentOrConfig?: Commitment | GetBlockHeightConfig): Promise<number>;
}

export interface ConfirmOptions {
    timeoutMs?: number;
    fastPollMs?: number;
    slowPollMs?: number;
    fastPollCount?: number;
    heightCheckEvery?: number;
}

export const DEFAULT_CONFIRM_OPTIONS = {
    timeoutMs: 120_000,
    fastPollMs: 400,
    slowPollMs: 1500,
    fastPollCount: 5,
    heightCheckEvery: 5,
} as const;

const FIRST_RATE_LIMIT_BACKOFF_MS = 1000;
const MAX_RATE_LIMIT_BACKOFF_MS = 8000;

export type ConfirmResult =
    | { status: 'confirmed' }
    | { status: 'failed'; err: unknown }
    | { status: 'expired' }
    | { status: 'unknown'; err?: unknown }

export type RpcErrorKind = 'rate-limited' | 'permanent' | 'transient';

const PERMANENT_JSON_RPC_CODES = new Set([
    -32700,
    -32600,
    -32601,
    -32602,
    -32013,
]);

const PERMANENT_HTTP_CODES = new Set([400, 401, 403, 404]);

function numberField(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === 'number' ? value : undefined;
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : {};
}

function httpStatusFromMessage(message: string): number | undefined {
    const match = /^(\d{3})\s/.exec(message);
    return match ? Number(match[1]) : undefined;
}

export function classifyRpcError(err: unknown): RpcErrorKind {
    const source = (typeof err === 'object' && err !== null) ? err as Record<string, unknown> : {};
    const message = typeof source.message === 'string' ? source.message : String(err ?? '');
    const code = numberField(source, 'code') ?? numberField(objectField(source, 'context'), 'code');
    const httpStatus = numberField(source, 'status')
        ?? numberField(source, 'statusCode')
        ?? httpStatusFromMessage(message);

    if (httpStatus === 429 || code === 429 || /429|too many requests|rate.?limit/i.test(message)) {
        return 'rate-limited';
    }

    if (code !== undefined && PERMANENT_JSON_RPC_CODES.has(code)) {
        return 'permanent';
    }

    if (httpStatus !== undefined && PERMANENT_HTTP_CODES.has(httpStatus)) {
        return 'permanent';
    }

    return 'transient';
}

export function analyseSignatureStatus(s: SignatureStatus | null): ConfirmResult | 'pending' | 'not-found' {
    if (s) {
        if (s.err) {
            return { status: 'failed', err: s.err };
        }

        if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
            return { status: 'confirmed' };
        }
    } else {
        return 'not-found';
    }
    return 'pending';
}

export async function confirmBySignature(connection: SignatureConfirmer, signature: string, lastValidBlockHeight: number, options: ConfirmOptions = {}): Promise<ConfirmResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CONFIRM_OPTIONS.timeoutMs;
    const fastPollMs = options.fastPollMs ?? DEFAULT_CONFIRM_OPTIONS.fastPollMs;
    const slowPollMs = options.slowPollMs ?? DEFAULT_CONFIRM_OPTIONS.slowPollMs;
    const fastPollCount = options.fastPollCount ?? DEFAULT_CONFIRM_OPTIONS.fastPollCount;
    const heightCheckEvery = Math.max(1, options.heightCheckEvery ?? DEFAULT_CONFIRM_OPTIONS.heightCheckEvery);
    const deadline = Date.now() + timeoutMs;
    let tick = 0;
    let lastError: unknown;
    let rateLimitBackoffMs = 0;

    while (Date.now() < deadline) {
        try {
            let output: ConfirmResult | 'not-found' | 'pending';
            const signatureStatus = await connection.getSignatureStatuses([signature]);
            rateLimitBackoffMs = 0;
            const s = signatureStatus.value[0];
            output = analyseSignatureStatus(s);
            if (output !== 'not-found' && output !== 'pending') {
                return output;
            }

            if (++tick % heightCheckEvery === 0) {
                const currentBlockHeight = await connection.getBlockHeight("confirmed");
                if (currentBlockHeight > lastValidBlockHeight) {
                    const currentStatus = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
                    const s2 = currentStatus.value[0];
                    output = analyseSignatureStatus(s2);
                    if (output === 'not-found') {
                        return { status: 'expired' };
                    } else if (output !== 'pending') {
                        return output;
                    }
                }
            }
        } catch (err) {
            const kind = classifyRpcError(err);
            if (kind === 'permanent') {
                throw err;
            }
            lastError = err;
            if (kind === 'rate-limited') {
                rateLimitBackoffMs = rateLimitBackoffMs === 0
                    ? FIRST_RATE_LIMIT_BACKOFF_MS
                    : Math.min(rateLimitBackoffMs * 2, MAX_RATE_LIMIT_BACKOFF_MS);
            }
        }

        await new Promise(r => setTimeout(r, (tick <= fastPollCount ? fastPollMs : slowPollMs) + rateLimitBackoffMs));
    }

    return { status: 'unknown', err: lastError };
}
