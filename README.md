create a github readme

## Description
This is a signer for Solana, that implements the Wormhole Signer interface.
The signer submits transactions as a jito bundle to the Solana network.

It could be a good idea to use this when the solana network is congested and you want to give validators an extra tip to include your transaction in the next block.

## Installation
Clone the repository and run `npm install`

## Usage
Import the signer and use it as you would use a Wormhole Signer.

```javascript
import { getSolanaSignAndSendSigner } from "./src/index.js";

signer = await getSolanaSignAndSendSigner(
    rpc,
    process.env.SOL_SIGNER_PRIV_KEY,
    {
        debug: true,
        priorityFeePercentile: 0.5,
        sendOpts: {
            commitment: "confirmed",
        },
    }
);
```
