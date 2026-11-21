/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/metrex_exchange.json`.
 */
export type MetrexExchange = {
  "address": "BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko",
  "metadata": {
    "name": "metrexExchange",
    "version": "0.2.0",
    "spec": "0.1.0",
    "description": "MetrEx Exchange v2: binary outcome tokens and an escrowed order book (docs/spec-v2.md)"
  },
  "instructions": [
    {
      "name": "cancelOrder",
      "discriminator": [
        95,
        129,
        237,
        240,
        8,
        49,
        223,
        132
      ],
      "accounts": [
        {
          "name": "maker",
          "writable": true,
          "signer": true,
          "relations": [
            "order"
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
                "path": "market.round",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "order"
          ]
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "escrowMint"
        },
        {
          "name": "makerRefund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "escrowMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "closeRound",
      "discriminator": [
        149,
        14,
        81,
        88,
        230,
        226,
        234,
        37
      ],
      "accounts": [
        {
          "name": "caller",
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
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
          "name": "roundController",
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          }
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
                "kind": "account",
                "path": "property.property_id",
                "account": "property"
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "property.property_id",
                "account": "property"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  121,
                  101,
                  115,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "noMint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  110,
                  111,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "market"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
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
                "path": "market"
              }
            ]
          }
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
      "args": []
    },
    {
      "name": "createRound",
      "discriminator": [
        229,
        218,
        236,
        169,
        231,
        80,
        134,
        112
      ],
      "accounts": [
        {
          "name": "roundController",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "config.next_round_id",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "previousRound",
          "docs": [
            "`config.latest_round`; required once any round exists. Read-only."
          ],
          "optional": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "scenarioId",
          "type": "u16"
        },
        {
          "name": "datasetSha256",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
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
          "name": "tradingEndsAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "expireMarket",
      "discriminator": [
        213,
        191,
        249,
        51,
        63,
        168,
        186,
        180
      ],
      "accounts": [
        {
          "name": "caller",
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": []
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
          "name": "collateralMint",
          "docs": [
            "mUSD. Every collateral token account is checked against it."
          ]
        },
        {
          "name": "program",
          "address": "BrHisWF8aXQzrCvvDPMsPXJyMXwVrWQTB479jtvB6Fko"
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
          "name": "roundController",
          "type": "pubkey"
        },
        {
          "name": "oracleAuthority",
          "type": "pubkey"
        },
        {
          "name": "resolutionTimeoutS",
          "type": "i64"
        }
      ]
    },
    {
      "name": "invalidateMarket",
      "discriminator": [
        177,
        26,
        12,
        213,
        10,
        199,
        236,
        179
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "reason",
          "type": "u8"
        }
      ]
    },
    {
      "name": "matchOrders",
      "discriminator": [
        17,
        1,
        201,
        93,
        7,
        51,
        251,
        134
      ],
      "accounts": [
        {
          "name": "caller",
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
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "buyOrder",
            "sellOrder"
          ]
        },
        {
          "name": "outcomeMint"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "buyOrder",
          "writable": true
        },
        {
          "name": "buyEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "buyOrder"
              }
            ]
          }
        },
        {
          "name": "sellOrder",
          "writable": true
        },
        {
          "name": "sellEscrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "sellOrder"
              }
            ]
          }
        },
        {
          "name": "buyerShares",
          "writable": true
        },
        {
          "name": "buyerCollateral",
          "writable": true
        },
        {
          "name": "sellerCollateral",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "merge",
      "discriminator": [
        148,
        141,
        236,
        47,
        174,
        126,
        69,
        111
      ],
      "accounts": [
        {
          "name": "holder",
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
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "holderCollateral",
          "writable": true
        },
        {
          "name": "holderYes",
          "writable": true
        },
        {
          "name": "holderNo",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "placeOrder",
      "discriminator": [
        51,
        194,
        155,
        175,
        109,
        130,
        96,
        106
      ],
      "accounts": [
        {
          "name": "maker",
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
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "order",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  100,
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
                "path": "maker"
              },
              {
                "kind": "arg",
                "path": "clientNonce"
              }
            ]
          }
        },
        {
          "name": "escrowMint",
          "docs": [
            "Collateral for BUY, the outcome mint for SELL (side/outcome match checked in the handler)."
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "makerSource",
          "writable": true
        },
        {
          "name": "receiveMint",
          "docs": [
            "The outcome mint for BUY, collateral for SELL."
          ]
        },
        {
          "name": "makerReceive",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "receiveMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "clientNonce",
          "type": "u64"
        },
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "side",
          "type": "u8"
        },
        {
          "name": "priceBps",
          "type": "u16"
        },
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "expiresAt",
          "type": "i64"
        }
      ]
    },
    {
      "name": "redeem",
      "discriminator": [
        184,
        12,
        86,
        149,
        70,
        196,
        97,
        225
      ],
      "accounts": [
        {
          "name": "holder",
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
                "path": "market.round",
                "account": "market"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "outcomeMint",
          "docs": [
            "The market's YES or NO mint, matching `outcome` (checked in the handler)."
          ],
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "holderShares",
          "writable": true
        },
        {
          "name": "holderCollateral",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "outcome",
          "type": "u8"
        },
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
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
          "name": "round",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
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
      "name": "split",
      "discriminator": [
        124,
        189,
        27,
        43,
        216,
        40,
        147,
        66
      ],
      "accounts": [
        {
          "name": "holder",
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
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          }
        },
        {
          "name": "yesMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "noMint",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "vault",
          "writable": true,
          "relations": [
            "market"
          ]
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "holderCollateral",
          "writable": true
        },
        {
          "name": "holderYes",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "yesMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "holderNo",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "holder"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "noMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        }
      ]
    },
    {
      "name": "sweepOrder",
      "discriminator": [
        195,
        180,
        78,
        217,
        114,
        108,
        107,
        148
      ],
      "accounts": [
        {
          "name": "caller",
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
          "name": "round",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "order"
          ]
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "maker",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "escrowMint"
        },
        {
          "name": "makerRefund",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "maker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "escrowMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "takeOrder",
      "discriminator": [
        163,
        208,
        20,
        172,
        223,
        65,
        255,
        228
      ],
      "accounts": [
        {
          "name": "taker",
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
          "name": "round",
          "docs": [
            "Read-only: fills never write Round (§6.6)."
          ],
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  110,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "round.round_id",
                "account": "round"
              }
            ]
          },
          "relations": [
            "market"
          ]
        },
        {
          "name": "market",
          "docs": [
            "Read-only: fills never write Market (§6.6)."
          ],
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
                "path": "round"
              },
              {
                "kind": "account",
                "path": "market.property_id",
                "account": "market"
              }
            ]
          },
          "relations": [
            "order"
          ]
        },
        {
          "name": "order",
          "writable": true
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "order"
              }
            ]
          }
        },
        {
          "name": "escrowMint"
        },
        {
          "name": "receiveMint",
          "docs": [
            "The counter-asset (checked against the order's side and outcome in the handler)."
          ]
        },
        {
          "name": "makerReceive",
          "writable": true
        },
        {
          "name": "takerSource",
          "writable": true
        },
        {
          "name": "takerReceive",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "taker"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "escrowMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "quantity",
          "type": "u64"
        },
        {
          "name": "limitPriceBps",
          "type": "u16"
        },
        {
          "name": "expectedSeq",
          "type": "u64"
        }
      ]
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
      "name": "order",
      "discriminator": [
        134,
        173,
        223,
        185,
        77,
        86,
        28,
        51
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
    },
    {
      "name": "round",
      "discriminator": [
        87,
        127,
        165,
        51,
        73,
        78,
        116,
        174
      ]
    }
  ],
  "events": [
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
      "name": "orderCancelled",
      "discriminator": [
        108,
        56,
        128,
        68,
        168,
        113,
        168,
        239
      ]
    },
    {
      "name": "orderFilled",
      "discriminator": [
        120,
        124,
        109,
        66,
        249,
        116,
        174,
        30
      ]
    },
    {
      "name": "orderPlaced",
      "discriminator": [
        96,
        130,
        204,
        234,
        169,
        219,
        216,
        227
      ]
    },
    {
      "name": "roundClosed",
      "discriminator": [
        45,
        243,
        28,
        22,
        132,
        70,
        175,
        226
      ]
    },
    {
      "name": "roundCreated",
      "discriminator": [
        16,
        19,
        68,
        117,
        87,
        198,
        7,
        124
      ]
    },
    {
      "name": "sharesMerged",
      "discriminator": [
        159,
        116,
        132,
        13,
        58,
        218,
        36,
        86
      ]
    },
    {
      "name": "sharesRedeemed",
      "discriminator": [
        232,
        166,
        7,
        56,
        67,
        19,
        42,
        117
      ]
    },
    {
      "name": "sharesSplit",
      "discriminator": [
        126,
        78,
        180,
        196,
        205,
        173,
        202,
        229
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
      "name": "invalidMint",
      "msg": "Token mint does not match this market or Config"
    },
    {
      "code": 6002,
      "name": "invalidTokenAccount",
      "msg": "Token account owner or address is not the expected one"
    },
    {
      "code": 6003,
      "name": "invalidMintConfig",
      "msg": "Collateral mint must have 6 decimals and no freeze authority"
    },
    {
      "code": 6004,
      "name": "roleConflict",
      "msg": "Admin, round controller and oracle must be distinct, non-default keys"
    },
    {
      "code": 6005,
      "name": "invalidCoordinates",
      "msg": "Latitude or longitude out of range"
    },
    {
      "code": 6006,
      "name": "invalidTriggerDistance",
      "msg": "Trigger distance must be positive"
    },
    {
      "code": 6007,
      "name": "unsupportedScenario",
      "msg": "Scenario is not supported"
    },
    {
      "code": 6008,
      "name": "scenarioMismatch",
      "msg": "Property scenario does not match the round"
    },
    {
      "code": 6009,
      "name": "previousRoundOpen",
      "msg": "The previous round is still open"
    },
    {
      "code": 6010,
      "name": "invalidDeadline",
      "msg": "Trading deadline is invalid"
    },
    {
      "code": 6011,
      "name": "invalidTimeout",
      "msg": "Resolution timeout is out of bounds"
    },
    {
      "code": 6012,
      "name": "roundNotOpen",
      "msg": "Round is not open"
    },
    {
      "code": 6013,
      "name": "tradingEnded",
      "msg": "Trading deadline has passed"
    },
    {
      "code": 6014,
      "name": "roundNotClosed",
      "msg": "Round is not closed"
    },
    {
      "code": 6015,
      "name": "marketResolved",
      "msg": "Market is already resolved"
    },
    {
      "code": 6016,
      "name": "marketNotResolved",
      "msg": "Market is not resolved"
    },
    {
      "code": 6017,
      "name": "resolutionWindowClosed",
      "msg": "The oracle resolution window has closed"
    },
    {
      "code": 6018,
      "name": "resolutionWindowOpen",
      "msg": "The oracle resolution window is still open"
    },
    {
      "code": 6019,
      "name": "invalidEvidenceHash",
      "msg": "Evidence hash must be non-zero"
    },
    {
      "code": 6020,
      "name": "invalidOutcome",
      "msg": "Outcome must be 0 (YES) or 1 (NO)"
    },
    {
      "code": 6021,
      "name": "invalidSide",
      "msg": "Side must be 0 (BUY) or 1 (SELL)"
    },
    {
      "code": 6022,
      "name": "invalidPrice",
      "msg": "Price must be between 1 and 9,999 basis points"
    },
    {
      "code": 6023,
      "name": "invalidQuantity",
      "msg": "Quantity is out of range"
    },
    {
      "code": 6024,
      "name": "invalidExpiry",
      "msg": "Expiry must be zero or in the future"
    },
    {
      "code": 6025,
      "name": "orderExpired",
      "msg": "Order has expired"
    },
    {
      "code": 6026,
      "name": "orderNotActive",
      "msg": "Order has no remaining quantity"
    },
    {
      "code": 6027,
      "name": "orderMismatch",
      "msg": "Orders do not belong to the same market, outcome or opposite sides"
    },
    {
      "code": 6028,
      "name": "orderSeqMismatch",
      "msg": "Order sequence does not match the quoted order"
    },
    {
      "code": 6029,
      "name": "ordersDoNotCross",
      "msg": "Buy price is below sell price"
    },
    {
      "code": 6030,
      "name": "priceLimitExceeded",
      "msg": "Order price is outside the taker's limit"
    },
    {
      "code": 6031,
      "name": "selfTrade",
      "msg": "Maker and taker are the same wallet"
    },
    {
      "code": 6032,
      "name": "notSweepable",
      "msg": "Order cannot be swept yet"
    },
    {
      "code": 6033,
      "name": "insufficientPairs",
      "msg": "Quantity exceeds outstanding pairs"
    },
    {
      "code": 6034,
      "name": "losingOutcome",
      "msg": "These shares did not win"
    },
    {
      "code": 6035,
      "name": "insufficientFunds",
      "msg": "Insufficient token balance"
    },
    {
      "code": 6036,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6037,
      "name": "notImplemented",
      "msg": "Instruction not implemented in this build"
    }
  ],
  "types": [
    {
      "name": "config",
      "docs": [
        "Seeds `[\"config\"]` (§6.1)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "roundController",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "type": "pubkey"
          },
          {
            "name": "latestRound",
            "docs": [
              "`Pubkey::default()` until the first round. The frontend features this round."
            ],
            "type": "pubkey"
          },
          {
            "name": "nextRoundId",
            "type": "u64"
          },
          {
            "name": "resolutionTimeoutS",
            "type": "i64"
          },
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "market",
      "docs": [
        "Seeds `[\"market\", round, property_id: u16 LE]` (§6.4)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "propertyId",
            "type": "u16"
          },
          {
            "name": "scenarioId",
            "type": "u16"
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
            "name": "triggerDistanceM",
            "type": "u32"
          },
          {
            "name": "yesMint",
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": {
              "defined": {
                "name": "outcome"
              }
            }
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
            "name": "pairsOutstanding",
            "docs": [
              "`split` adds, `merge` subtracts. Booked backing before resolution (§4.6)."
            ],
            "type": "u64"
          },
          {
            "name": "nextOrderSeq",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "resolvedAt",
            "type": "i64"
          },
          {
            "name": "resolutionPath",
            "type": "u8"
          },
          {
            "name": "invalidReason",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "yesMintBump",
            "type": "u8"
          },
          {
            "name": "noMintBump",
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
      "name": "marketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "propertyId",
            "type": "u16"
          },
          {
            "name": "yesMint",
            "type": "pubkey"
          },
          {
            "name": "noMint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
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
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "1 Yes, 2 No, 3 Invalid."
            ],
            "type": "u8"
          },
          {
            "name": "path",
            "docs": [
              "`PATH_ORACLE`, `PATH_EMERGENCY` or `PATH_EXPIRY`."
            ],
            "type": "u8"
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
            "name": "reason",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "order",
      "docs": [
        "Seeds `[\"order\", market, maker, client_nonce: u64 LE]` (§6.5). Escrow: `[\"escrow\", order]`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "clientNonce",
            "type": "u64"
          },
          {
            "name": "outcome",
            "docs": [
              "`OUTCOME_YES` or `OUTCOME_NO`."
            ],
            "type": "u8"
          },
          {
            "name": "side",
            "docs": [
              "`SIDE_BUY` or `SIDE_SELL`."
            ],
            "type": "u8"
          },
          {
            "name": "priceBps",
            "type": "u16"
          },
          {
            "name": "originalQty",
            "type": "u64"
          },
          {
            "name": "remainingQty",
            "type": "u64"
          },
          {
            "name": "seq",
            "docs": [
              "Priority; lower is older. Not a seed."
            ],
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "docs": [
              "0 = no expiry."
            ],
            "type": "i64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "escrowBump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "orderCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "swept",
            "type": "bool"
          },
          {
            "name": "remainingQty",
            "type": "u64"
          },
          {
            "name": "returnedAmount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderFilled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "buyOrder",
            "docs": [
              "`Pubkey::default()` when the buyer was a direct taker."
            ],
            "type": "pubkey"
          },
          {
            "name": "sellOrder",
            "docs": [
              "`Pubkey::default()` when the seller was a direct taker."
            ],
            "type": "pubkey"
          },
          {
            "name": "buyer",
            "type": "pubkey"
          },
          {
            "name": "seller",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "priceBps",
            "type": "u16"
          },
          {
            "name": "quoteAmount",
            "type": "u64"
          },
          {
            "name": "buyerRefund",
            "type": "u64"
          },
          {
            "name": "makerOrder",
            "docs": [
              "The older (resting) order whose price applied."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "orderPlaced",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "order",
            "type": "pubkey"
          },
          {
            "name": "maker",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "side",
            "type": "u8"
          },
          {
            "name": "priceBps",
            "type": "u16"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "seq",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "outcome",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "unresolved"
          },
          {
            "name": "yes"
          },
          {
            "name": "no"
          },
          {
            "name": "invalid"
          }
        ]
      }
    },
    {
      "name": "property",
      "docs": [
        "Seeds `[\"property\", property_id: u16 LE]` (§6.2). Same layout as v1.1."
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
    },
    {
      "name": "round",
      "docs": [
        "Seeds `[\"round\", round_id: u64 LE]` (§6.3)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "scenarioId",
            "type": "u16"
          },
          {
            "name": "datasetSha256",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
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
            "name": "status",
            "type": {
              "defined": {
                "name": "roundStatus"
              }
            }
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "tradingEndsAt",
            "type": "i64"
          },
          {
            "name": "closedAt",
            "type": "i64"
          },
          {
            "name": "marketCount",
            "type": "u16"
          },
          {
            "name": "resolvedCount",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "roundClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "closedAt",
            "type": "i64"
          },
          {
            "name": "byController",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "roundCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "round",
            "type": "pubkey"
          },
          {
            "name": "roundId",
            "type": "u64"
          },
          {
            "name": "scenarioId",
            "type": "u16"
          },
          {
            "name": "datasetSha256",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tradingEndsAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "roundStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "sharesMerged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sharesRedeemed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "payout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "sharesSplit",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "market",
            "type": "pubkey"
          },
          {
            "name": "holder",
            "type": "pubkey"
          },
          {
            "name": "quantity",
            "type": "u64"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
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
      "name": "escrowSeed",
      "type": "bytes",
      "value": "[101, 115, 99, 114, 111, 119]"
    },
    {
      "name": "invalidPayoutPerShare",
      "docs": [
        "Base units paid per share of either outcome when the market is Invalid."
      ],
      "type": "u64",
      "value": "500000"
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
      "name": "maxMatchLevels",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "maxOrderQty",
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "maxPriceBps",
      "type": "u16",
      "value": "9999"
    },
    {
      "name": "maxResolutionTimeoutS",
      "type": "i64",
      "value": "2592000"
    },
    {
      "name": "maxRoundDurationS",
      "type": "i64",
      "value": "2592000"
    },
    {
      "name": "maxSplitQty",
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "maxTakeLevels",
      "type": "u8",
      "value": "4"
    },
    {
      "name": "minOrderQty",
      "type": "u64",
      "value": "1"
    },
    {
      "name": "minPriceBps",
      "type": "u16",
      "value": "1"
    },
    {
      "name": "minResolutionTimeoutS",
      "type": "i64",
      "value": "10"
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
      "name": "noMintSeed",
      "type": "bytes",
      "value": "[110, 111, 95, 109, 105, 110, 116]"
    },
    {
      "name": "orderSeed",
      "type": "bytes",
      "value": "[111, 114, 100, 101, 114]"
    },
    {
      "name": "outcomeNo",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "outcomeYes",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "pathEmergency",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "pathExpiry",
      "type": "u8",
      "value": "3"
    },
    {
      "name": "pathNone",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "pathOracle",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "payoutPerShare",
      "docs": [
        "Base units paid per winning share."
      ],
      "type": "u64",
      "value": "1000000"
    },
    {
      "name": "programVersion",
      "type": "u8",
      "value": "2"
    },
    {
      "name": "propertySeed",
      "type": "bytes",
      "value": "[112, 114, 111, 112, 101, 114, 116, 121]"
    },
    {
      "name": "quotePerShareBps",
      "docs": [
        "`quote = quantity × price_bps × QUOTE_PER_SHARE_BPS`."
      ],
      "type": "u64",
      "value": "100"
    },
    {
      "name": "roundSeed",
      "type": "bytes",
      "value": "[114, 111, 117, 110, 100]"
    },
    {
      "name": "scenarioPalisades2025",
      "type": "u16",
      "value": "1"
    },
    {
      "name": "shareDecimals",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "sideBuy",
      "type": "u8",
      "value": "0"
    },
    {
      "name": "sideSell",
      "type": "u8",
      "value": "1"
    },
    {
      "name": "vaultSeed",
      "type": "bytes",
      "value": "[118, 97, 117, 108, 116]"
    },
    {
      "name": "yesMintSeed",
      "type": "bytes",
      "value": "[121, 101, 115, 95, 109, 105, 110, 116]"
    }
  ]
};
