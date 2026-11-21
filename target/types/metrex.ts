/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/metrex.json`.
 */
export type Metrex = {
  "address": "AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X",
  "metadata": {
    "name": "metrex",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "MetrEx: on-chain underwriting exchange for parametric wildfire risk"
  },
  "instructions": [
    {
      "name": "acceptOffer",
      "discriminator": [
        227,
        82,
        234,
        131,
        1,
        18,
        48,
        2
      ],
      "accounts": [
        {
          "name": "homeowner",
          "signer": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          },
          "relations": [
            "offer"
          ]
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              }
            ]
          }
        },
        {
          "name": "homeownerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "buyPosition",
      "discriminator": [
        210,
        108,
        108,
        28,
        10,
        46,
        226,
        137
      ],
      "accounts": [
        {
          "name": "buyer",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          },
          "relations": [
            "offer"
          ]
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          },
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              },
              {
                "kind": "account",
                "path": "listing.side",
                "account": "listing"
              }
            ]
          }
        },
        {
          "name": "seller",
          "writable": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "buyerToken",
          "writable": true
        },
        {
          "name": "sellerToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "cancelListing",
      "discriminator": [
        41,
        183,
        50,
        232,
        230,
        233,
        157,
        70
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true,
          "relations": [
            "listing"
          ]
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "listing.offer",
                "account": "listing"
              },
              {
                "kind": "account",
                "path": "listing.side",
                "account": "listing"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "cancelOffer",
      "discriminator": [
        92,
        203,
        223,
        40,
        92,
        89,
        53,
        119
      ],
      "accounts": [
        {
          "name": "underwriter",
          "writable": true,
          "signer": true,
          "relations": [
            "offer"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              }
            ]
          }
        },
        {
          "name": "underwriterToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "claimPayout",
      "discriminator": [
        127,
        240,
        132,
        62,
        227,
        198,
        146,
        133
      ],
      "accounts": [
        {
          "name": "claimant",
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          },
          "relations": [
            "offer"
          ]
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              }
            ]
          }
        },
        {
          "name": "claimantToken",
          "writable": true
        },
        {
          "name": "underwriter",
          "writable": true,
          "relations": [
            "offer"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "closeMarket",
      "discriminator": [
        88,
        154,
        248,
        186,
        48,
        14,
        123,
        244
      ],
      "accounts": [
        {
          "name": "demoController",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createMarket",
      "discriminator": [
        103,
        226,
        97,
        235,
        200,
        188,
        251,
        254
      ],
      "accounts": [
        {
          "name": "homeowner",
          "writable": true,
          "signer": true
        },
        {
          "name": "property",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "propertyId"
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "homeowner"
              },
              {
                "kind": "arg",
                "path": "marketNonce"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "marketNonce",
          "type": "u64"
        },
        {
          "name": "propertyId",
          "type": "u16"
        },
        {
          "name": "coverageTarget",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initializeConfig",
      "discriminator": [
        208,
        127,
        21,
        1,
        194,
        190,
        196,
        70
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "The mUSD mint. Stored in Config; every token account is checked against it."
          ]
        },
        {
          "name": "program",
          "address": "AHSbJKM2kihhjNcaEhpwvDpX9DADQ2E36KX8tfCigu8X"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracle",
          "type": "pubkey"
        },
        {
          "name": "controller",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "listPosition",
      "discriminator": [
        252,
        73,
        186,
        182,
        15,
        2,
        202,
        83
      ],
      "accounts": [
        {
          "name": "seller",
          "writable": true,
          "signer": true
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          },
          "relations": [
            "offer"
          ]
        },
        {
          "name": "offer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          }
        },
        {
          "name": "listing",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  108,
                  105,
                  115,
                  116,
                  105,
                  110,
                  103
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              },
              {
                "kind": "arg",
                "path": "side"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "price",
          "type": "u64"
        }
      ]
    },
    {
      "name": "placeOffer",
      "discriminator": [
        55,
        98,
        219,
        43,
        72,
        108,
        121,
        97
      ],
      "accounts": [
        {
          "name": "underwriter",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "market"
              },
              {
                "kind": "account",
                "path": "underwriter"
              },
              {
                "kind": "arg",
                "path": "offerNonce"
              }
            ]
          }
        },
        {
          "name": "mint",
          "docs": [
            "Declared before `vault` because the vault's `init` reads it."
          ]
        },
        {
          "name": "vault",
          "docs": [
            "Escrow for this offer. Token authority is the Offer PDA (§5.5)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              }
            ]
          }
        },
        {
          "name": "underwriterToken",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "offerNonce",
          "type": "u64"
        },
        {
          "name": "coverage",
          "type": "u64"
        },
        {
          "name": "premiumBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "refundOffer",
      "discriminator": [
        171,
        18,
        70,
        32,
        244,
        121,
        60,
        75
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          },
          "relations": [
            "offer"
          ]
        },
        {
          "name": "offer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "offer.market",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.underwriter",
                "account": "offer"
              },
              {
                "kind": "account",
                "path": "offer.offer_nonce",
                "account": "offer"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "offer"
              }
            ]
          }
        },
        {
          "name": "homeownerToken",
          "writable": true
        },
        {
          "name": "underwriterToken",
          "writable": true
        },
        {
          "name": "underwriter",
          "writable": true,
          "relations": [
            "offer"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "registerProperty",
      "discriminator": [
        25,
        115,
        131,
        71,
        59,
        22,
        25,
        16
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "property",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "propertyId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "propertyId",
          "type": "u16"
        },
        {
          "name": "label",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "latE6",
          "type": "i32"
        },
        {
          "name": "lonE6",
          "type": "i32"
        },
        {
          "name": "scenarioId",
          "type": "u16"
        },
        {
          "name": "triggerDistanceM",
          "type": "u32"
        }
      ]
    },
    {
      "name": "resolveMarket",
      "discriminator": [
        155,
        23,
        80,
        173,
        46,
        74,
        23,
        239
      ],
      "accounts": [
        {
          "name": "oracleAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "triggered",
          "type": "bool"
        },
        {
          "name": "evidenceHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "voidMarket",
      "discriminator": [
        243,
        175,
        46,
        124,
        95,
        101,
        39,
        69
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "market",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  114,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market.homeowner",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.market_nonce",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "listing",
      "discriminator": [
        218,
        32,
        50,
        73,
        43,
        134,
        26,
        58
      ]
    },
    {
      "name": "market",
      "discriminator": [
        219,
        190,
        213,
        55,
        0,
        227,
        198,
        154
      ]
    },
    {
      "name": "offer",
      "discriminator": [
        215,
        88,
        60,
        71,
        170,
        162,
        73,
        229
      ]
    },
    {
      "name": "property",
      "discriminator": [
        195,
        247,
        69,
        181,
        195,
        47,
        152,
        19
      ]
    }
  ],
  "events": [
    {
      "name": "listingCancelled",
      "discriminator": [
        11,
        46,
        163,
        10,
        103,
        80,
        139,
        194
      ]
    },
    {
      "name": "marketClosed",
      "discriminator": [
        86,
        91,
        119,
        43,
        94,
        0,
        217,
        113
      ]
    },
    {
      "name": "marketCreated",
      "discriminator": [
        88,
        184,
        130,
        231,
        226,
        84,
        6,
        58
      ]
    },
    {
      "name": "marketResolved",
      "discriminator": [
        89,
        67,
        230,
        95,
        143,
        106,
        199,
        202
      ]
    },
    {
      "name": "marketVoided",
      "discriminator": [
        217,
        12,
        138,
        39,
        108,
        75,
        89,
        26
      ]
    },
    {
      "name": "offerAccepted",
      "discriminator": [
        81,
        238,
        238,
        115,
        140,
        18,
        8,
        20
      ]
    },
    {
      "name": "offerCancelled",
      "discriminator": [
        45,
        42,
        175,
        214,
        51,
        192,
        154,
        9
      ]
    },
    {
      "name": "offerPlaced",
      "discriminator": [
        233,
        184,
        192,
        153,
        227,
        71,
        86,
        83
      ]
    },
    {
      "name": "offerRefunded",
      "discriminator": [
        132,
        208,
        236,
        25,
        125,
        249,
        160,
        13
      ]
    },
    {
      "name": "payoutClaimed",
      "discriminator": [
        200,
        39,
        105,
        112,
        116,
        63,
        58,
        149
      ]
    },
    {
      "name": "positionBought",
      "discriminator": [
        195,
        211,
        22,
        156,
        218,
        3,
        223,
        135
      ]
    },
    {
      "name": "positionListed",
      "discriminator": [
        182,
        248,
        5,
        32,
        220,
        197,
        216,
        164
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized for this action"
    },
    {
      "code": 6001,
      "name": "invalidMarketStatus",
      "msg": "Market is not in a status that allows this action"
    },
    {
      "code": 6002,
      "name": "invalidOfferStatus",
      "msg": "Offer is not in a status that allows this action"
    },
    {
      "code": 6003,
      "name": "invalidBps",
      "msg": "Premium rate must be between 1 and 9,999 bps"
    },
    {
      "code": 6004,
      "name": "coverageTooSmall",
      "msg": "Coverage is below the minimum"
    },
    {
      "code": 6005,
      "name": "coverageExceedsTarget",
      "msg": "Coverage exceeds the market's coverage target"
    },
    {
      "code": 6006,
      "name": "coverageExceedsRemaining",
      "msg": "Accepting this offer would exceed the remaining coverage"
    },
    {
      "code": 6007,
      "name": "premiumRoundsToZero",
      "msg": "Premium rounds to zero"
    },
    {
      "code": 6008,
      "name": "selfUnderwriting",
      "msg": "The homeowner cannot underwrite their own market"
    },
    {
      "code": 6009,
      "name": "wrongMint",
      "msg": "Token account has the wrong mint"
    },
    {
      "code": 6010,
      "name": "wrongTokenOwner",
      "msg": "Token account has the wrong owner"
    },
    {
      "code": 6011,
      "name": "offerMarketMismatch",
      "msg": "Offer does not belong to this market"
    },
    {
      "code": 6012,
      "name": "notWinner",
      "msg": "Only the winning side can claim"
    },
    {
      "code": 6013,
      "name": "invalidCoordinates",
      "msg": "Coordinates or trigger distance out of range"
    },
    {
      "code": 6014,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6015,
      "name": "vaultBalanceMismatch",
      "msg": "Vault balance does not match the expected amount"
    },
    {
      "code": 6016,
      "name": "notHolder",
      "msg": "Signer does not hold this side of the position"
    },
    {
      "code": 6017,
      "name": "staleListing",
      "msg": "Listing seller no longer holds this side"
    },
    {
      "code": 6018,
      "name": "selfTrade",
      "msg": "Buyer cannot be the seller or the opposite-side holder"
    },
    {
      "code": 6019,
      "name": "invalidPrice",
      "msg": "Price must be at least 1 base unit"
    },
    {
      "code": 6020,
      "name": "insufficientFunds",
      "msg": "Insufficient mUSD balance"
    },
    {
      "code": 6021,
      "name": "invalidSide",
      "msg": "Side must be 0 (Protection) or 1 (Risk)"
    }
  ],
  "types": [
    {
      "name": "config",
      "docs": [
        "Global configuration. Seeds: `[\"config\"]` (§5.1)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "demoController",
            "type": "pubkey"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "listing",
      "docs": [
        "Tier 2. Seeds: `[\"listing\", offer, side: u8]` (§5.6)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "side",
            "docs": [
              "0 = Protection, 1 = Risk."
            ],
            "type": "u8"
          },
          {
            "name": "seller",
            "docs": [
              "Must equal the current holder of `side` when listed and when bought."
            ],
            "type": "pubkey"
          },
          {
            "name": "price",
            "docs": [
              "mUSD base units the buyer pays the seller."
            ],
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "listingCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "seller",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "market",
      "docs": [
        "Seeds: `[\"market\", homeowner, market_nonce: u64 LE]` (§5.3)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "homeowner",
            "type": "pubkey"
          },
          {
            "name": "marketNonce",
            "type": "u64"
          },
          {
            "name": "propertyId",
            "type": "u16"
          },
          {
            "name": "latE6",
            "docs": [
              "Copied from Property at creation."
            ],
            "type": "i32"
          },
          {
            "name": "lonE6",
            "type": "i32"
          },
          {
            "name": "scenarioId",
            "type": "u16"
          },
          {
            "name": "triggerDistanceM",
            "type": "u32"
          },
          {
            "name": "coverageTarget",
            "type": "u64"
          },
          {
            "name": "coverageActivated",
            "docs": [
              "Sum of accepted offers' coverage."
            ],
            "type": "u64"
          },
          {
            "name": "acceptedCount",
            "type": "u16"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "marketStatus"
              }
            }
          },
          {
            "name": "evidenceHash",
            "docs": [
              "Zero until resolved."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "closedAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "marketClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "closedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "homeowner",
            "type": "pubkey"
          },
          {
            "name": "propertyId",
            "type": "u16"
          },
          {
            "name": "coverageTarget",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketResolved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "triggered",
            "type": "bool"
          },
          {
            "name": "evidenceHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "marketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "closed"
          },
          {
            "name": "resolvedYes"
          },
          {
            "name": "resolvedNo"
          },
          {
            "name": "voided"
          }
        ]
      }
    },
    {
      "name": "marketVoided",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "offer",
      "docs": [
        "Seeds: `[\"offer\", market, underwriter, offer_nonce: u64 LE]` (§5.4).",
        "Vault seeds: `[\"vault\", offer]` (§5.5)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "underwriter",
            "type": "pubkey"
          },
          {
            "name": "offerNonce",
            "type": "u64"
          },
          {
            "name": "coverage",
            "docs": [
              "C"
            ],
            "type": "u64"
          },
          {
            "name": "premiumBps",
            "docs": [
              "b"
            ],
            "type": "u16"
          },
          {
            "name": "premium",
            "docs": [
              "P = floor(C × b / 10_000), computed on-chain."
            ],
            "type": "u64"
          },
          {
            "name": "collateral",
            "docs": [
              "K = C − P, computed on-chain."
            ],
            "type": "u64"
          },
          {
            "name": "protectionHolder",
            "docs": [
              "`Pubkey::default()` until accepted; then the homeowner. Receives the vault on YES."
            ],
            "type": "pubkey"
          },
          {
            "name": "riskHolder",
            "docs": [
              "`Pubkey::default()` until accepted; then the underwriter. Receives the vault on NO."
            ],
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "offerStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "acceptedAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "offerAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "homeowner",
            "type": "pubkey"
          },
          {
            "name": "underwriter",
            "type": "pubkey"
          },
          {
            "name": "coverage",
            "type": "u64"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "coverageActivated",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "offerCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "underwriter",
            "type": "pubkey"
          },
          {
            "name": "refunded",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "offerPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "underwriter",
            "type": "pubkey"
          },
          {
            "name": "coverage",
            "type": "u64"
          },
          {
            "name": "premiumBps",
            "type": "u16"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "offerRefunded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "homeowner",
            "type": "pubkey"
          },
          {
            "name": "underwriter",
            "type": "pubkey"
          },
          {
            "name": "premium",
            "type": "u64"
          },
          {
            "name": "collateral",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "offerStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "accepted"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "claimed"
          },
          {
            "name": "refunded"
          }
        ]
      }
    },
    {
      "name": "payoutClaimed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "claimant",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "positionBought",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "positionListed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "offer",
            "type": "pubkey"
          },
          {
            "name": "listing",
            "type": "pubkey"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "price",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "property",
      "docs": [
        "Admin-registered property. Seeds: `[\"property\", property_id: u16 LE]` (§5.2)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "propertyId",
            "type": "u16"
          },
          {
            "name": "label",
            "docs": [
              "UTF-8, zero-padded."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "latE6",
            "type": "i32"
          },
          {
            "name": "lonE6",
            "type": "i32"
          },
          {
            "name": "scenarioId",
            "type": "u16"
          },
          {
            "name": "triggerDistanceM",
            "type": "u32"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "bpsDenominator",
      "type": "u64",
      "value": "10000"
    },
    {
      "name": "configSeed",
      "type": "bytes",
      "value": "[99, 111, 110, 102, 105, 103]"
    },
    {
      "name": "defaultTriggerDistanceM",
      "type": "u32",
      "value": "500"
    },
    {
      "name": "listingSeed",
      "type": "bytes",
      "value": "[108, 105, 115, 116, 105, 110, 103]"
    },
    {
      "name": "marketSeed",
      "type": "bytes",
      "value": "[109, 97, 114, 107, 101, 116]"
    },
    {
      "name": "maxAbsLatE6",
      "type": "i32",
      "value": "90000000"
    },
    {
      "name": "maxAbsLonE6",
      "type": "i32",
      "value": "180000000"
    },
    {
      "name": "maxBps",
      "type": "u16",
      "value": "9999"
    },
    {
      "name": "maxCoverageTarget",
      "type": "u64",
      "value": "1000000000000"
    },
    {
      "name": "minBps",
      "type": "u16",
      "value": "1"
    },
    {
      "name": "minCoverage",
      "type": "u64",
      "value": "10000000"
    },
    {
      "name": "musdDecimals",
      "type": "u8",
      "value": "6"
    },
    {
      "name": "musdUnit",
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "offerSeed",
      "type": "bytes",
      "value": "[111, 102, 102, 101, 114]"
    },
    {
      "name": "propertySeed",
      "type": "bytes",
      "value": "[112, 114, 111, 112, 101, 114, 116, 121]"
    },
    {
      "name": "scenarioPalisades2025",
      "type": "u16",
      "value": "1"
    },
    {
      "name": "sideProtection",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "sideRisk",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    }
  ]
};
