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
    | { status: 'unknown' }

export function analyseSignatureStatus(s: SignatureStatus | null): ConfirmResult | 'pending' | 'not-found' {
    if (s) {
        if (s.err) {
            return { status: 'failed', err: s.err};
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
    while (Date.now() < deadline) {
        try {
            let output: ConfirmResult | 'not-found' | 'pending';
            const signatureStatus = await connection.getSignatureStatuses([signature]);
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

        }

        await new Promise(r => setTimeout(r, tick < 6 ? 400: 1500));
    }

    return { status: 'unknown' };
}
