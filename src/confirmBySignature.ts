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

const RATE_LIMIT_WORDING = /429|too many requests|rate.?limit/i;

const HTTP_STATUS_AT_START_OF_MESSAGE = /^(\d{3})\s/;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === 'number' ? value : undefined;
}

function objectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return (typeof value === 'object' && value !== null) ? value as Record<string, unknown> : {};
}

function httpStatusFromMessage(message: string): number | undefined {
    const match = HTTP_STATUS_AT_START_OF_MESSAGE.exec(message);
    if (match === null) {
        return undefined;
    }
    return Number(match[1]);
}

export function classifyRpcError(err: unknown): RpcErrorKind {
    const isObject = typeof err === 'object' && err !== null;
    const source = isObject ? err as Record<string, unknown> : {};

    const message = typeof source.message === 'string' ? source.message : String(err ?? '');

    const topLevelCode = numberField(source, 'code');
    const kitContextCode = numberField(objectField(source, 'context'), 'code');
    const jsonRpcCode = topLevelCode ?? kitContextCode;

    const statusField = numberField(source, 'status') ?? numberField(source, 'statusCode');
    const httpStatus = statusField ?? httpStatusFromMessage(message);

    const saysRateLimited = RATE_LIMIT_WORDING.test(message);
    const isRateLimited = httpStatus === 429 || jsonRpcCode === 429 || saysRateLimited;
    if (isRateLimited) {
        return 'rate-limited';
    }

    const isPermanentJsonRpcCode = jsonRpcCode !== undefined && PERMANENT_JSON_RPC_CODES.has(jsonRpcCode);
    const isPermanentHttpStatus = httpStatus !== undefined && PERMANENT_HTTP_CODES.has(httpStatus);
    if (isPermanentJsonRpcCode || isPermanentHttpStatus) {
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
    const requestedHeightCheckEvery = options.heightCheckEvery ?? DEFAULT_CONFIRM_OPTIONS.heightCheckEvery;
    const heightCheckEvery = Math.max(1, requestedHeightCheckEvery);

    const deadline = Date.now() + timeoutMs;
    let tick = 0;
    let lastError: unknown;
    let rateLimitBackoffMs = 0;

    while (Date.now() < deadline) {
        try {
            const cheapPoll = await connection.getSignatureStatuses([signature]);
            rateLimitBackoffMs = 0;

            const cheapOutcome = analyseSignatureStatus(cheapPoll.value[0]);
            const cheapPollDecided = cheapOutcome !== 'not-found' && cheapOutcome !== 'pending';
            if (cheapPollDecided) {
                return cheapOutcome;
            }

            tick = tick + 1;
            const timeToCheckBlockHeight = tick % heightCheckEvery === 0;

            if (timeToCheckBlockHeight) {
                const currentBlockHeight = await connection.getBlockHeight("confirmed");
                const blockhashExpired = currentBlockHeight > lastValidBlockHeight;

                if (blockhashExpired) {
                    const ledgerSearch = await connection.getSignatureStatuses(
                        [signature], { searchTransactionHistory: true });
                    const ledgerOutcome = analyseSignatureStatus(ledgerSearch.value[0]);

                    if (ledgerOutcome === 'not-found') {
                        return { status: 'expired' };
                    }
                    if (ledgerOutcome !== 'pending') {
                        return ledgerOutcome;
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
                const isFirstRateLimit = rateLimitBackoffMs === 0;
                const doubled = rateLimitBackoffMs * 2;
                rateLimitBackoffMs = isFirstRateLimit
                    ? FIRST_RATE_LIMIT_BACKOFF_MS
                    : Math.min(doubled, MAX_RATE_LIMIT_BACKOFF_MS);
            }
        }

        const stillPollingFast = tick <= fastPollCount;
        const pollInterval = stillPollingFast ? fastPollMs : slowPollMs;
        await sleep(pollInterval + rateLimitBackoffMs);
    }

    return { status: 'unknown', err: lastError };
}
