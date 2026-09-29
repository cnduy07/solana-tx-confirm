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

export type ConfirmResult =
    | { status: 'confirmed' }
    | { status: 'failed'; err: unknown }
    | { status: 'expired' }
    | { status: 'unknown'; err?: unknown }

export type RpcErrorKind = 'rate-limited' | 'permanent' | 'transient';

const PERMANENT_JSON_RPC_CODES = new Set([
    -32700, // parse error
    -32600, // invalid request
    -32601, // method not found
    -32602, // invalid params
    -32013, // transaction signature length mismatch
]);

const PERMANENT_HTTP_CODES = new Set([400, 401, 403, 404]);

function numberField(source: Record<string, unknown>, key: string): number | undefined {
    const value = source[key];
    return typeof value === 'number' ? value : undefined;
}

export function classifyRpcError(err: unknown): RpcErrorKind {
    const source = (typeof err === 'object' && err !== null) ? err as Record<string, unknown> : {};
    const code = numberField(source, 'code');
    const httpStatus = numberField(source, 'status') ?? numberField(source, 'statusCode');
    const message = typeof source.message === 'string' ? source.message : String(err ?? '');

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


export async function confirmBySignature(connection: SignatureConfirmer, signature: string, lastValidBlockHeight: number): Promise<ConfirmResult> {
    const deadline = Date.now() + 120000;
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

            if (++tick % 5 === 0) {
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
            // An RPC failure says nothing about the transaction, so it can never
            // produce 'failed' or 'expired' - only a retry, or 'unknown' at the end.
            const kind = classifyRpcError(err);
            if (kind === 'permanent') {
                throw err;
            }
            lastError = err;
            if (kind === 'rate-limited') {
                rateLimitBackoffMs = rateLimitBackoffMs === 0 ? 1000 : Math.min(rateLimitBackoffMs * 2, 8000);
            }
        }

        await new Promise(r => setTimeout(r, (tick < 6 ? 400 : 1500) + rateLimitBackoffMs));
    }

    return { status: 'unknown', err: lastError };
}
