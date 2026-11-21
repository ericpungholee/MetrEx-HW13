"use client";

import { useAnchorWallet, useWallet } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import type { WalletSigner } from "./client";

export function useWalletSigner(): WalletSigner | undefined {
  const wallet = useAnchorWallet();
  const { sendTransaction } = useWallet();
  return useMemo(() => wallet && { ...wallet, sendTransaction }, [wallet, sendTransaction]);
}
