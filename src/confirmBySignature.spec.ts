import assert from 'node:assert';
import sinon from 'sinon';
import { analyseSignatureStatus, classifyRpcError, confirmBySignature } from './confirmBySignature.ts';
import type { SignatureConfirmer } from './confirmBySignature.ts';
import type { SignatureStatus, SignatureStatusConfig } from '@solana/web3.js';

describe('analyseSignatureStatus', () => {
    it('return not-found when there is no status', () => {
        const input = null;
        const result = analyseSignatureStatus(input);
        assert.strictEqual(result, 'not-found');
    });

    it('returns failed when err is set, even if confirmationStatus is confirmed', () => {
        const input: SignatureStatus = {
            "slot": 148293041,
            "confirmations": null,
            "err": {
                "InstructionError": [
                    0,
                    { "Custom": 6001 }
                ]
            },
            "confirmationStatus": "confirmed"
        };
        const result = analyseSignatureStatus(input)
        assert.deepStrictEqual(result, { status: 'failed', err: input.err })
    });

    it('return confirmed when confirmationStatus is confirmed', () => {
        const input: SignatureStatus = {
            "slot": 148293041,
            "confirmations": null,
            "err": null,
            "confirmationStatus": "confirmed"
        };
        const result = analyseSignatureStatus(input)
        assert.deepStrictEqual(result, { status: 'confirmed' })
    });

    it('return confirmed when confirmationStatus is finalized', () => {
        const input: SignatureStatus = {
            "slot": 148293041,
            "confirmations": null,
            "err": null,
            "confirmationStatus": "finalized"
        };
        const result = analyseSignatureStatus(input)
        assert.deepStrictEqual(result, { status: 'confirmed' })
    });

    it('return pending when confirmationStatus is processed', () => {
        const input: SignatureStatus = {
            "slot": 148293041,
            "confirmations": null,
            "err": null,
            "confirmationStatus": "processed"
        };
        const result = analyseSignatureStatus(input)
        assert.strictEqual(result, 'pending')
    });

    it('return pending when confirmationStatus is undefined', () => {
        const input: SignatureStatus = {
            "slot": 148293041,
            "confirmations": null,
            "err": null,
            "confirmationStatus": undefined
        };
        const result = analyseSignatureStatus(input)
        assert.strictEqual(result, 'pending')
    });
});

describe('classifyRpcError', () => {
    // The shapes below were captured from a real Connection hitting a local
    // server, so they are what @solana/web3.js v1 actually rejects with.

    describe('rate-limited', () => {
        it('reads a 429 from the front of a bare Error message (web3.js v1 shape)', () => {
            assert.strictEqual(classifyRpcError(new Error('429 Too Many Requests: {}')), 'rate-limited');
        });

        it('reads a 429 from a status field (other HTTP clients)', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('x'), { status: 429 })), 'rate-limited');
        });

        it('reads a 429 from a numeric code field', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('x'), { code: 429 })), 'rate-limited');
        });

        it('recognises "rate limit" wording without any status', () => {
            assert.strictEqual(classifyRpcError(new Error('Your app has exceeded its rate limit')), 'rate-limited');
        });
    });

    describe('permanent', () => {
        it('treats HTTP 401 in the message as permanent (a wrong API key never fixes itself)', () => {
            assert.strictEqual(classifyRpcError(new Error('401 Unauthorized: {"error":"bad api key"}')), 'permanent');
        });

        it('treats HTTP 403 in the message as permanent', () => {
            assert.strictEqual(classifyRpcError(new Error('403 Forbidden: {}')), 'permanent');
        });

        it('treats a malformed signature (-32013) as permanent', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('WrongSize'), { code: -32013 })), 'permanent');
        });

        it('treats invalid params (-32602) as permanent', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('Invalid param'), { code: -32602 })), 'permanent');
        });

        it('reads the code from context.code as well (@solana/kit shape)', () => {
            assert.strictEqual(classifyRpcError({ message: 'x', context: { code: -32602 } }), 'permanent');
        });
    });

    describe('transient', () => {
        // This is the test that fails if anyone ever rewrites the classifier as
        // "has an HTTP status -> permanent". The status value decides, not its presence.
        it('treats HTTP 500 as transient, not permanent', () => {
            assert.strictEqual(classifyRpcError(new Error('500 Internal Server Error: oops')), 'transient');
        });

        it('treats a node that is behind (-32005) as transient', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('Node is behind'), { code: -32005 })), 'transient');
        });

        it('treats missing ledger history (-32011) as transient, so cheap RPCs still get an answer', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('history not available'), { code: -32011 })), 'transient');
        });

        it('ignores a string code such as ECONNRESET instead of reading it as a JSON-RPC code', () => {
            assert.strictEqual(classifyRpcError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), 'transient');
        });

        it('handles a network failure', () => {
            assert.strictEqual(classifyRpcError(new TypeError('fetch failed')), 'transient');
        });

        it('survives a thrown value that is not an Error', () => {
            assert.strictEqual(classifyRpcError(null), 'transient');
            assert.strictEqual(classifyRpcError('boom'), 'transient');
        });
    });
});

describe('confirmBySignature', () => {
    const SIG = 'sig';
    const LAST_VALID_BLOCK_HEIGHT = 1000;
    const EXPIRED_HEIGHT = LAST_VALID_BLOCK_HEIGHT + 1;

    // Poll intervals small enough that the real timer never dominates a test.
    const FAST = { fastPollMs: 1, slowPollMs: 1 };

    const status = (over: Partial<SignatureStatus>): SignatureStatus =>
        ({ slot: 1, confirmations: 1, err: null, ...over } as SignatureStatus);

    type Step = SignatureStatus | null | Error;

    /**
     * Builds a fresh fake per test - a factory rather than a shared object, so no
     * test can inherit another test's call counter.
     */
    function makeFake(script: { hot: Step[]; history?: Step; blockHeight?: number }) {
        let hotIndex = 0;
        const configs: Array<SignatureStatusConfig | undefined> = [];

        const unwrap = (step: Step) => {
            if (step instanceof Error) throw step;
            return { context: { slot: 1 }, value: [step ?? null] };
        };

        const connection: SignatureConfirmer = {
            async getSignatureStatuses(_signatures: string[], config?: SignatureStatusConfig) {
                configs.push(config);
                if (config?.searchTransactionHistory) {
                    return unwrap(script.history ?? null);
                }
                return unwrap(script.hot[Math.min(hotIndex++, script.hot.length - 1)] ?? null);
            },
            async getBlockHeight() {
                return script.blockHeight ?? 0;
            },
        };

        return { connection, configs };
    }

    let clock: sinon.SinonFakeTimers | undefined;
    afterEach(() => {
        clock?.restore();
        clock = undefined;
    });

    it('returns confirmed once the status reaches confirmed', async () => {
        const { connection } = makeFake({ hot: [status({ confirmationStatus: 'confirmed' })] });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT),
            { status: 'confirmed' });
    });

    it('returns failed when the transaction landed with an error', async () => {
        const err = { InstructionError: [0, { Custom: 6001 }] };
        const { connection } = makeFake({ hot: [status({ err, confirmationStatus: 'confirmed' })] });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT),
            { status: 'failed', err });
    });

    it('returns expired only once the ledger search also finds nothing', async () => {
        const { connection } = makeFake({ hot: [null], history: null, blockHeight: EXPIRED_HEIGHT });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, heightCheckEvery: 1 }),
            { status: 'expired' });
    });

    // The bug this library exists for: after a restart the signature has dropped
    // out of the RPC's recent cache, so the cheap poll returns null forever while
    // the block height is long past. Without the ledger search this reports a
    // successful buy as expired.
    it('returns confirmed when the signature fell out of the recent cache but is in the ledger', async () => {
        const { connection } = makeFake({
            hot: [null],
            history: status({ confirmationStatus: 'finalized' }),
            blockHeight: EXPIRED_HEIGHT,
        });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, heightCheckEvery: 1 }),
            { status: 'confirmed' });
    });

    // A transaction that is only 'processed' is already inside a block, so the
    // expired blockhash cannot undo it. Reporting expired here would be a lie.
    it('keeps waiting when the ledger search finds the transaction still processed', async () => {
        const { connection } = makeFake({
            hot: [null, status({ confirmationStatus: 'confirmed' })],
            history: status({ confirmationStatus: 'processed' }),
            blockHeight: EXPIRED_HEIGHT,
        });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, heightCheckEvery: 1 }),
            { status: 'confirmed' });
    });

    it('throws straight away on a permanent RPC error instead of polling for the full timeout', async () => {
        const { connection } = makeFake({ hot: [Object.assign(new Error('WrongSize'), { code: -32013 })] });
        // The short timeout is deliberate: if the throw is ever removed, this
        // resolves within milliseconds and assert.rejects reports a clear failure
        // rather than letting the suite hang for the full default timeout.
        await assert.rejects(
            () => confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, timeoutMs: 30 }),
            (err: unknown) => (err as { code?: number }).code === -32013);
    });

    it('retries a transient RPC error and still reports the real outcome', async () => {
        const { connection } = makeFake({
            hot: [new TypeError('fetch failed'), status({ confirmationStatus: 'confirmed' })],
        });
        assert.deepStrictEqual(
            await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, FAST),
            { status: 'confirmed' });
    });

    it('never asks the ledger from the hot loop, and asks it exactly once past the block height', async () => {
        const { connection, configs } = makeFake({ hot: [null], history: null, blockHeight: EXPIRED_HEIGHT });

        await confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, heightCheckEvery: 3 });

        const searched = configs.filter(c => c?.searchTransactionHistory === true);
        assert.strictEqual(searched.length, 1, 'the ledger must be searched exactly once');
        // Three cheap polls come first; the expensive one is last, after the
        // height check fired on the third tick.
        assert.strictEqual(configs.length, 4);
        assert.deepStrictEqual(configs.slice(0, 3), [undefined, undefined, undefined]);
    });

    it('reports unknown with the last error when the RPC never answers', async () => {
        const { connection } = makeFake({ hot: [new TypeError('fetch failed')] });

        const result = await confirmBySignature(
            connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, timeoutMs: 20 });

        assert.strictEqual(result.status, 'unknown');
        assert.ok(result.status === 'unknown' && result.err instanceof TypeError);
    });

    it('reports unknown without an error when the RPC answered but nothing ever landed', async () => {
        const { connection } = makeFake({ hot: [null], blockHeight: 0 });

        const result = await confirmBySignature(
            connection, SIG, LAST_VALID_BLOCK_HEIGHT, { ...FAST, timeoutMs: 20 });

        assert.strictEqual(result.status, 'unknown');
        assert.strictEqual(result.status === 'unknown' ? result.err : 'missing', undefined);
    });

    describe('with fake timers', () => {
        it('backs off 1s then 2s while the RPC rate limits, on top of the poll interval', async () => {
            clock = sinon.useFakeTimers();
            const callTimes: number[] = [];
            let attempt = 0;

            const connection: SignatureConfirmer = {
                async getSignatureStatuses() {
                    callTimes.push(Date.now());
                    if (attempt++ < 2) throw new Error('429 Too Many Requests: {}');
                    return { context: { slot: 1 }, value: [status({ confirmationStatus: 'confirmed' })] };
                },
                async getBlockHeight() { return 0; },
            };

            const pending = confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT);
            await clock.tickAsync(10_000);

            assert.deepStrictEqual(await pending, { status: 'confirmed' });
            // 400 + 1000, then 400 + 2000.
            assert.deepStrictEqual(callTimes, [0, 1400, 3800]);
        });

        it('gives up at the default 120s timeout without waiting for real time', async () => {
            clock = sinon.useFakeTimers();
            const connection: SignatureConfirmer = {
                async getSignatureStatuses() { throw new TypeError('fetch failed'); },
                async getBlockHeight() { return 0; },
            };

            const pending = confirmBySignature(connection, SIG, LAST_VALID_BLOCK_HEIGHT);
            await clock.tickAsync(130_000);

            assert.strictEqual((await pending).status, 'unknown');
        });
    });
});
