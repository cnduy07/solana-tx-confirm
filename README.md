# solana-tx-confirm

Confirm Solana transactions by signature polling. Returns `confirmed`, `failed`, `expired`, or `unknown`.

No runtime dependencies. Takes an RPC client as a parameter, so it is testable without a network.

## The four results

You sent a transaction and you have a signature. Did it land? The answer is not a boolean. There are
four genuinely different outcomes, and collapsing them into success or failure is how bots end up
buying the same token twice.

| Result | Meaning | What to do |
| --- | --- | --- |
| `confirmed` | Landed, no error | Apply the result |
| `failed` | Landed, the runtime returned an error | Reset state |
| `expired` | Not on chain, and the blockhash is no longer valid, so it can never land | Retry with a fresh blockhash |
| `unknown` | The RPC never gave a definitive answer | Keep the signature, do not retry |

The last one matters most. `unknown` means "I could not find out", not "it did not happen". The
transaction may well have succeeded. If you treat it as a failure and resend, you risk submitting
the same trade twice. Store the pending signature and resolve it on a later pass.

## Install

Not published to npm. Install from GitHub:

```bash
npm install github:cnduy07/solana-tx-confirm
```

`@solana/web3.js` is a peer dependency, used only for its type definitions. The package declares no
runtime dependencies and the compiled output contains no `require` of web3.js.

## Usage

```ts
import { Connection } from '@solana/web3.js';
import { confirmBySignature } from 'solana-tx-confirm';

const connection = new Connection(process.env.RPC_URL!, 'confirmed');
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

// sign and send a transaction built with `blockhash`

const result = await confirmBySignature(connection, signature, lastValidBlockHeight);

switch (result.status) {
    case 'confirmed': break;
    case 'failed':    break;  // result.err holds the runtime error
    case 'expired':   break;
    case 'unknown':   break;  // keep the signature, do not resend
}
```

`lastValidBlockHeight` is the value returned alongside the blockhash the transaction was signed
with. Past that height the transaction can no longer be included in a block.

## Errors that throw

The four results always resolve. One class of problem rejects instead: a request that is malformed,
so retrying it can never help.

```ts
try {
    await confirmBySignature(connection, signature, lastValidBlockHeight);
} catch (err) {
    // malformed signature (-32013), invalid params (-32602), HTTP 401 or 403
}
```

This is deliberate. A malformed signature is a bug in the calling code, not a runtime condition to
wait out. Returning `unknown` for it would hide the bug behind 120 seconds of pointless polling.

Since Node 15 an unhandled promise rejection terminates the process, so a missing `catch` will not
pass silently.

## Why not the usual approaches

### Sleep, then read the wallet balance

```ts
await sleep(30_000);
const balance = await getTokenBalance(mint);
```

Two problems. A balance that has not changed does not tell you whether the transaction failed or is
still in flight, and those need opposite handling. And if anything else touched that account in the
meantime, the change you measured was not necessarily yours.

### `connection.confirmTransaction()`

Correct for the flow it was designed for: send a transaction and await it immediately in the same
process.

It breaks down when the process restarts. `confirmTransaction` opens a signature subscription now, so
a notification that already fired is gone, and it backs that up with a single `getSignatureStatus`
call. That call passes no config, so it only reads the RPC's recent status cache. The string
`searchTransactionHistory` does not appear anywhere in the web3.js runtime bundle, so there is no
path that looks in the ledger.

A signature young enough to still be cached is therefore found. An older one is a cache miss, block
height then passes `lastValidBlockHeight`, and it throws
`TransactionExpiredBlockheightExceededError` for a transaction that may have confirmed minutes ago.

### Polling the signature with no height check

`getSignatureStatuses` alone never tells you to stop. A transaction whose blockhash expired simply
stays absent, so a naive poll loop waits out its whole timeout and reports nothing useful.

`expired` needs two facts, and they come from two different places:

1. the transaction is not on chain, from the signature status
2. it can no longer get on chain, from the block height

## After a restart

The cheap form of `getSignatureStatuses` only searches the RPC's recent status cache. An older
signature is a cache miss, which looks exactly like "never landed".

So when the block height has passed `lastValidBlockHeight`, and only then, this library asks once
more with `searchTransactionHistory: true`, which searches the ledger. If that finds nothing the
result is `expired`. If it finds an error the result is `failed`. If it finds `confirmed` or
`finalized` the result is `confirmed`.

The expensive search runs once, at the moment the answer would otherwise be wrong. The hot loop
stays on the cheap call.

If the ledger search finds the transaction at `processed`, the library keeps polling. A `processed`
transaction is already inside a block. An expired blockhash prevents inclusion, and inclusion has
already happened, so there is nothing left to expire. Reporting `expired` there would be a lie about
a transaction that is about to confirm. It resolves within a slot or two in whichever direction is
true.

## Timing

| Option | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | 120000 | Give up and return `unknown` after this long |
| `fastPollMs` | 400 | Interval for the first few attempts |
| `slowPollMs` | 1500 | Interval afterwards |
| `fastPollCount` | 5 | How many attempts use the fast interval |
| `heightCheckEvery` | 5 | Check the block height on every Nth attempt |

```ts
await confirmBySignature(connection, signature, lastValidBlockHeight, { timeoutMs: 30_000 });
```

`heightCheckEvery` is a cost trade-off. At the default of 5, five attempts cost six RPC calls, or
1.2 per attempt. Checking on every attempt costs 2 per attempt instead. Checking less often delays
expiry detection: at the defaults it is noticed about 1.6 seconds into the run, and up to 7.5
seconds later on once the interval has widened to `slowPollMs`.

## Works with any RPC client

The first parameter is not a `Connection`. It is the two read-only methods this library actually
calls:

```ts
export interface SignatureConfirmer {
    getSignatureStatuses(
        signatures: Array<TransactionSignature>,
        config?: SignatureStatusConfig,
    ): Promise<RpcResponseAndContext<Array<SignatureStatus | null>>>;

    getBlockHeight(commitmentOrConfig?: Commitment | GetBlockHeightConfig): Promise<number>;
}
```

A `Connection` satisfies this as it is, because TypeScript matches on shape rather than on class
name. So does anything else with those two methods:

```ts
const adapter: SignatureConfirmer = {
    getSignatureStatuses: (signatures, config) => myClient.signatureStatuses(signatures, config),
    getBlockHeight: (commitment) => myClient.blockHeight(commitment),
};
```

Two consequences. The signature is the documentation: it shows the library only reads status, with
no sending, no signing, no wallet and no keys, so you do not have to take that on trust. And the
tests need no network, because every scenario is driven by a hand written object. That is why the
suite runs in milliseconds.

`@solana/kit`, formerly web3.js v2, shapes its RPC calls differently, so it needs an adapter of this
kind rather than being passed directly.

## Error classification

An RPC failure says nothing about the transaction. It can therefore never produce `failed` or
`expired`, only a retry or `unknown` at the end. Errors are sorted into three kinds.

`rate-limited` retries with an extra delay that doubles each time: 1s, 2s, 4s, capped at 8s.
HTTP 429 lands here.

`permanent` throws immediately. A malformed signature (-32013), invalid params (-32602) and
HTTP 401 or 403 land here.

`transient` retries at the normal interval. HTTP 5xx, `fetch failed`, a node that is behind
(-32005) and an RPC with no ledger history (-32011) land here.

Classification reads the error's shape rather than its class, so a custom client's errors are sorted
too. That matters more than it sounds, because the code is in a different place in each case.
`SolanaJSONRPCError` from web3.js v1 puts it on `err.code`. `SolanaError` from `@solana/kit` puts it
on `err.context.code`. Axios and similar clients use `err.status` or `err.statusCode`. And HTTP
failures from web3.js v1 carry it in the message and nowhere else.

That last case is not a guess. A `Connection` pointed at a server returning 401 rejects with a plain
`Error` whose own property list is empty:

```
constructor : Error
message     : "401 Unauthorized: {\"error\":\"bad api key\"}"
own keys    : []
```

The status survives only at the front of the message, so that is where this library reads it from.
Without that, a wrong API key would be classified `transient` and polled for the full timeout.

Note that web3.js v1 already retries HTTP 429 up to five times internally, with its own backoff,
before the error surfaces here. The delays add up.

## Tests

```bash
npm run typecheck
npm test
```

34 tests, under 100ms, with no network and no real waiting. The two tests that assert on timing, the
rate limit backoff schedule and the 120 second timeout, use `sinon` fake timers and
`clock.tickAsync()`. Plain `tick()` is not enough, because the loop awaits a promise between timers
and needs the event loop to turn.

Tests run on Node's native type stripping, Node 23 or newer, so there is no transpiler in the test
path. One consequence to keep in mind: type stripping does not type check. `npm test` passing does
not mean the types are sound, so run `npm run typecheck` as well.

The suite was checked by mutation testing: six deliberate breaks to the source, each one turning
tests red. One of those breaks initially passed, which is how the missing `heightCheckEvery: 0` test
got written.

## Known limitations

Blockhash expiry only. Durable nonce transactions are not supported, because they do not expire by
block height.

`-32011` is treated as transient. An RPC that keeps no ledger history cannot answer the history
search, so such a setup ends at `unknown` with the error attached rather than at a wrong `expired`.

`JSON.stringify` drops the error. `Error.message` is not an enumerable own property, so
`JSON.stringify(result)` prints `"err":{}`. Log `result.err` separately.

The backoff constants are not configurable. The 1s starting delay and the 8s cap are internal.

The types are borrowed from web3.js v1. Declaring a minimal set instead would make the package
version independent. Not done yet.

## License

MIT
