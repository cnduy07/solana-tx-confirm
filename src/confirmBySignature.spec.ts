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
    function errorWithFields(message: string, fields: Record<string, unknown>): Error {
        return Object.assign(new Error(message), fields);
    }

    describe('rate-limited', () => {
        it('reads a 429 from the front of a bare Error message (web3.js v1 shape)', () => {
            const error = new Error('429 Too Many Requests: {}');
            assert.strictEqual(classifyRpcError(error), 'rate-limited');
        });

        it('reads a 429 from a status field (other HTTP clients)', () => {
            const error = errorWithFields('rejected', { status: 429 });
            assert.strictEqual(classifyRpcError(error), 'rate-limited');
        });

        it('reads a 429 from a numeric code field', () => {
            const error = errorWithFields('rejected', { code: 429 });
            assert.strictEqual(classifyRpcError(error), 'rate-limited');
        });

        it('recognises "rate limit" wording without any status', () => {
            const error = new Error('Your app has exceeded its rate limit');
            assert.strictEqual(classifyRpcError(error), 'rate-limited');
        });
    });

    describe('permanent', () => {
        it('treats HTTP 401 in the message as permanent (a wrong API key never fixes itself)', () => {
            const error = new Error('401 Unauthorized: {"error":"bad api key"}');
            assert.strictEqual(classifyRpcError(error), 'permanent');
        });

        it('treats HTTP 403 in the message as permanent', () => {
            const error = new Error('403 Forbidden: {}');
            assert.strictEqual(classifyRpcError(error), 'permanent');
        });

        it('treats a malformed signature (-32013) as permanent', () => {
            const error = errorWithFields('WrongSize', { code: -32013 });
            assert.strictEqual(classifyRpcError(error), 'permanent');
        });

        it('treats invalid params (-32602) as permanent', () => {
            const error = errorWithFields('Invalid param', { code: -32602 });
            assert.strictEqual(classifyRpcError(error), 'permanent');
        });

        it('reads the code from context.code as well (@solana/kit shape)', () => {
            const kitStyleError = { message: 'rejected', context: { code: -32602 } };
            assert.strictEqual(classifyRpcError(kitStyleError), 'permanent');
        });
    });

    describe('transient', () => {
        it('treats HTTP 500 as transient, not permanent', () => {
            const error = new Error('500 Internal Server Error: oops');
            assert.strictEqual(classifyRpcError(error), 'transient');
        });

        it('treats a node that is behind (-32005) as transient', () => {
            const error = errorWithFields('Node is behind', { code: -32005 });
            assert.strictEqual(classifyRpcError(error), 'transient');
        });

        it('treats missing ledger history (-32011) as transient, so cheap RPCs still get an answer', () => {
            const error = errorWithFields('history not available', { code: -32011 });
            assert.strictEqual(classifyRpcError(error), 'transient');
        });

        it('ignores a string code such as ECONNRESET instead of reading it as a JSON-RPC code', () => {
            const error = errorWithFields('socket hang up', { code: 'ECONNRESET' });
            assert.strictEqual(classifyRpcError(error), 'transient');
        });

        it('handles a network failure', () => {
            const error = new TypeError('fetch failed');
            assert.strictEqual(classifyRpcError(error), 'transient');
        });

        it('survives a thrown value that is not an Error', () => {
            assert.strictEqual(classifyRpcError(null), 'transient');
            assert.strictEqual(classifyRpcError('boom'), 'transient');
        });
    });
});

describe('confirmBySignature', () => {
    const SIGNATURE = 'a-signature';
    const LAST_VALID_BLOCK_HEIGHT = 1000;
    const HEIGHT_PAST_EXPIRY = LAST_VALID_BLOCK_HEIGHT + 1;
    const HEIGHT_STILL_VALID = LAST_VALID_BLOCK_HEIGHT - 1;

    const FAST_POLLING = { fastPollMs: 1, slowPollMs: 1 };
    const CHECK_HEIGHT_EVERY_TICK = { ...FAST_POLLING, heightCheckEvery: 1 };
    const GIVE_UP_QUICKLY = { ...FAST_POLLING, timeoutMs: 20 };

    function makeStatus(overrides: Partial<SignatureStatus>): SignatureStatus {
        const required = { slot: 1, confirmations: 1, err: null };
        return { ...required, ...overrides } as SignatureStatus;
    }

    const CONFIRMED = makeStatus({ confirmationStatus: 'confirmed' });
    const FINALIZED = makeStatus({ confirmationStatus: 'finalized' });
    const PROCESSED = makeStatus({ confirmationStatus: 'processed' });
    const NOT_FOUND = null;

    type ScriptedResponse = SignatureStatus | null | Error;

    interface Script {
        hotPolls: ScriptedResponse[];
        ledgerSearch?: ScriptedResponse;
        blockHeight?: number;
    }

    function makeFakeConnection(script: Script) {
        let hotPollCount = 0;
        const receivedConfigs: Array<SignatureStatusConfig | undefined> = [];

        function nextHotPollResponse(): ScriptedResponse {
            const lastIndex = script.hotPolls.length - 1;
            const index = hotPollCount < lastIndex ? hotPollCount : lastIndex;
            hotPollCount = hotPollCount + 1;
            return script.hotPolls[index] ?? NOT_FOUND;
        }

        function asRpcResponse(response: ScriptedResponse) {
            if (response instanceof Error) {
                throw response;
            }
            return { context: { slot: 1 }, value: [response] };
        }

        function isLedgerSearch(config: SignatureStatusConfig | undefined): boolean {
            return config?.searchTransactionHistory === true;
        }

        const connection: SignatureConfirmer = {
            async getSignatureStatuses(_signatures: string[], config?: SignatureStatusConfig) {
                receivedConfigs.push(config);

                if (isLedgerSearch(config)) {
                    return asRpcResponse(script.ledgerSearch ?? NOT_FOUND);
                }
                return asRpcResponse(nextHotPollResponse());
            },

            async getBlockHeight() {
                return script.blockHeight ?? HEIGHT_STILL_VALID;
            },
        };

        return { connection, receivedConfigs };
    }

    function expectUnknown(result: Awaited<ReturnType<typeof confirmBySignature>>) {
        if (result.status !== 'unknown') {
            assert.fail(`expected status "unknown" but got "${result.status}"`);
        }
        return result;
    }

    let clock: sinon.SinonFakeTimers | undefined;

    afterEach(() => {
        if (clock !== undefined) {
            clock.restore();
            clock = undefined;
        }
    });

    it('returns confirmed once the status reaches confirmed', async () => {
        const { connection } = makeFakeConnection({ hotPolls: [CONFIRMED] });

        const result = await confirmBySignature(connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT);

        assert.deepStrictEqual(result, { status: 'confirmed' });
    });

    it('returns failed when the transaction landed with an error', async () => {
        const transactionError = { InstructionError: [0, { Custom: 6001 }] };
        const failedStatus = makeStatus({ err: transactionError, confirmationStatus: 'confirmed' });
        const { connection } = makeFakeConnection({ hotPolls: [failedStatus] });

        const result = await confirmBySignature(connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT);

        assert.deepStrictEqual(result, { status: 'failed', err: transactionError });
    });

    it('returns expired only once the ledger search also finds nothing', async () => {
        const { connection } = makeFakeConnection({
            hotPolls: [NOT_FOUND],
            ledgerSearch: NOT_FOUND,
            blockHeight: HEIGHT_PAST_EXPIRY,
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, CHECK_HEIGHT_EVERY_TICK);

        assert.deepStrictEqual(result, { status: 'expired' });
    });

    it('returns confirmed when the signature fell out of the recent cache but is in the ledger', async () => {
        const { connection } = makeFakeConnection({
            hotPolls: [NOT_FOUND],
            ledgerSearch: FINALIZED,
            blockHeight: HEIGHT_PAST_EXPIRY,
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, CHECK_HEIGHT_EVERY_TICK);

        assert.deepStrictEqual(result, { status: 'confirmed' });
    });

    it('keeps waiting when the ledger search finds the transaction still processed', async () => {
        const { connection } = makeFakeConnection({
            hotPolls: [NOT_FOUND, CONFIRMED],
            ledgerSearch: PROCESSED,
            blockHeight: HEIGHT_PAST_EXPIRY,
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, CHECK_HEIGHT_EVERY_TICK);

        assert.deepStrictEqual(result, { status: 'confirmed' });
    });

    it('throws straight away on a permanent RPC error instead of polling for the full timeout', async () => {
        const malformedSignatureError = Object.assign(new Error('WrongSize'), { code: -32013 });
        const { connection } = makeFakeConnection({ hotPolls: [malformedSignatureError] });

        await assert.rejects(
            () => confirmBySignature(
                connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, { ...FAST_POLLING, timeoutMs: 30 }),
            (thrown: unknown) => thrown === malformedSignatureError,
        );
    });

    it('retries a transient RPC error and still reports the real outcome', async () => {
        const { connection } = makeFakeConnection({
            hotPolls: [new TypeError('fetch failed'), CONFIRMED],
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, FAST_POLLING);

        assert.deepStrictEqual(result, { status: 'confirmed' });
    });

    it('never asks the ledger from the hot loop, and asks it exactly once past the block height', async () => {
        const CHECK_HEIGHT_EVERY_THIRD_TICK = { ...FAST_POLLING, heightCheckEvery: 3 };
        const { connection, receivedConfigs } = makeFakeConnection({
            hotPolls: [NOT_FOUND],
            ledgerSearch: NOT_FOUND,
            blockHeight: HEIGHT_PAST_EXPIRY,
        });

        await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, CHECK_HEIGHT_EVERY_THIRD_TICK);

        const cheapPolls = receivedConfigs.filter(config => config === undefined);
        const ledgerSearches = receivedConfigs.filter(config => config?.searchTransactionHistory === true);
        const lastConfig = receivedConfigs[receivedConfigs.length - 1];

        assert.strictEqual(cheapPolls.length, 3, 'three cheap polls should run before the height check fires');
        assert.strictEqual(ledgerSearches.length, 1, 'the expensive ledger search must run exactly once');
        assert.strictEqual(receivedConfigs.length, 4, 'no other call should reach the RPC');
        assert.strictEqual(lastConfig?.searchTransactionHistory, true, 'the ledger search must come last');
    });

    it('still detects expiry when heightCheckEvery is zero, instead of dividing by zero and never checking', async () => {
        const NONSENSE_HEIGHT_CHECK = { ...FAST_POLLING, heightCheckEvery: 0, timeoutMs: 50 };
        const { connection } = makeFakeConnection({
            hotPolls: [NOT_FOUND],
            ledgerSearch: NOT_FOUND,
            blockHeight: HEIGHT_PAST_EXPIRY,
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, NONSENSE_HEIGHT_CHECK);

        assert.deepStrictEqual(result, { status: 'expired' });
    });

    it('reports unknown with the last error when the RPC never answers', async () => {
        const networkError = new TypeError('fetch failed');
        const { connection } = makeFakeConnection({ hotPolls: [networkError] });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, GIVE_UP_QUICKLY);

        const unknown = expectUnknown(result);
        assert.strictEqual(unknown.err, networkError);
    });

    it('reports unknown without an error when the RPC answered but nothing ever landed', async () => {
        const { connection } = makeFakeConnection({
            hotPolls: [NOT_FOUND],
            blockHeight: HEIGHT_STILL_VALID,
        });

        const result = await confirmBySignature(
            connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT, GIVE_UP_QUICKLY);

        const unknown = expectUnknown(result);
        assert.strictEqual(unknown.err, undefined);
    });

    describe('with fake timers', () => {
        it('backs off 1s then 2s while the RPC rate limits, on top of the poll interval', async () => {
            clock = sinon.useFakeTimers();

            const virtualCallTimes: number[] = [];
            const rateLimitError = new Error('429 Too Many Requests: {}');
            let attempt = 0;

            const connection: SignatureConfirmer = {
                async getSignatureStatuses() {
                    virtualCallTimes.push(Date.now());

                    const isOneOfTheFirstTwoAttempts = attempt < 2;
                    attempt = attempt + 1;
                    if (isOneOfTheFirstTwoAttempts) {
                        throw rateLimitError;
                    }
                    return { context: { slot: 1 }, value: [CONFIRMED] };
                },
                async getBlockHeight() {
                    return HEIGHT_STILL_VALID;
                },
            };

            const pending = confirmBySignature(connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT);
            await clock.tickAsync(10_000);
            const result = await pending;

            const firstCall = 0;
            const secondCall = firstCall + 400 + 1000;
            const thirdCall = secondCall + 400 + 2000;

            assert.deepStrictEqual(result, { status: 'confirmed' });
            assert.deepStrictEqual(virtualCallTimes, [firstCall, secondCall, thirdCall]);
        });

        it('gives up at the default 120s timeout without waiting for real time', async () => {
            clock = sinon.useFakeTimers();

            const connection: SignatureConfirmer = {
                async getSignatureStatuses() {
                    throw new TypeError('fetch failed');
                },
                async getBlockHeight() {
                    return HEIGHT_STILL_VALID;
                },
            };

            const pending = confirmBySignature(connection, SIGNATURE, LAST_VALID_BLOCK_HEIGHT);
            await clock.tickAsync(130_000);
            const result = await pending;

            expectUnknown(result);
        });
    });
});
