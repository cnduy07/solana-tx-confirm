import {
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
    | { status: 'expired'}
    | { status: 'unknown' }


export async function confirmBySignature(connection: SignatureConfirmer, signature: string, lastValidBlockHeight: number): Promise<ConfirmResult> {
    const deadline = Date.now() + 120000;
    let tick = 0;
    while (Date.now() < deadline) {
        try {
            const signatureStatus = await connection.getSignatureStatuses([signature]);
            const s = signatureStatus.value[0];

            if (s) {
                if (s.err) {
                    return { status: 'failed', err: s.err};
                }
                if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') {
                    return { status: 'confirmed'};
                }
            }

            if (++tick % 5 === 0) {
                const currentBlockHeight = await connection.getBlockHeight("confirmed");
                if (currentBlockHeight > lastValidBlockHeight) {
                    return { status: 'expired'}
                }
            }
        } catch (err) {

        }

        await new Promise(r => setTimeout(r, tick < 6 ? 400: 1500));
    }

    return { status: 'unknown' };
}
