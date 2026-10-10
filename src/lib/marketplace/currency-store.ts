"use client";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const DEFAULT_MARKET_CURRENCY =
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";

export const MARKET_CURRENCY_STORAGE_KEY = "realms-market-currency";

type MarketCurrencyState = {
  currency: string;
  setCurrency: (currency: string) => void;
};

/**
 * The market currency scopes floors, listings, offers and statistics, and is the
 * default currency for new orders. It is remembered per browser; hydration is
 * deferred so server and first client render agree (see MarketplaceProvider).
 */
export const useMarketCurrency = create<MarketCurrencyState>()(
  persist(
    (set) => ({
      currency: DEFAULT_MARKET_CURRENCY,
      setCurrency: (currency) => set({ currency }),
    }),
    {
      name: MARKET_CURRENCY_STORAGE_KEY,
      storage: createJSONStorage(() =>
        typeof window === "undefined" ? noopStorage : window.localStorage,
      ),
      partialize: (state) => ({ currency: state.currency }),
      skipHydration: true,
    },
  ),
);

const noopStorage: Storage = {
  length: 0,
  clear() {},
  getItem: () => null,
  key: () => null,
  removeItem() {},
  setItem() {},
};

export { sameCurrency } from "@/lib/marketplace/market-figures";
