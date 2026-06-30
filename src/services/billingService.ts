import {
  initConnection,
  fetchProducts,
  requestPurchase,
  finishTransaction,
  getAvailablePurchases,
  purchaseUpdatedListener,
  purchaseErrorListener,
  type Purchase,
  type PurchaseError,
  type EventSubscription,
} from "react-native-iap";
import { Linking } from "react-native";
import Constants from "expo-constants";
import functions from "@react-native-firebase/functions";
import { requiresPayment } from "../config/env";

export type SubscriptionSku = "monthly_499" | "yearly_3999";

const SKU_MAP: Record<SubscriptionSku, string> = {
  monthly_499: "com.ankiconversacionales.app.monthly",
  yearly_3999: "com.ankiconversacionales.app.yearly",
};

/** The Play product IDs we recognise as our subscription, for restore. */
const KNOWN_SUB_PRODUCT_IDS: string[] = Object.values(SKU_MAP);

/** Localized display prices keyed by plan (e.g. "$4.99"), as returned by Play. */
export interface SubscriptionPrices {
  monthly?: string;
  yearly?: string;
}

let purchaseUpdateSubscription: EventSubscription | null = null;
let purchaseErrorSubscription: EventSubscription | null = null;

/**
 * Initialize the billing connection and listeners.
 * Call once at app startup (prod mode only).
 */
export async function initBilling(): Promise<void> {
  if (!requiresPayment()) return;

  await initConnection();

  purchaseUpdateSubscription = purchaseUpdatedListener(
    async (purchase: Purchase) => {
      // Acknowledge the purchase
      await finishTransaction({ purchase });

      // Notify backend to update subscription status
      try {
        const callable = functions().httpsCallable("verifyPurchase");
        await callable({
          purchaseToken: (purchase as any).purchaseToken,
          productId: purchase.productId,
        });
      } catch (err) {
        console.error("[Billing] Failed to verify purchase:", err);
      }
    },
  );

  purchaseErrorSubscription = purchaseErrorListener((error: PurchaseError) => {
    console.error("[Billing] Purchase error:", error);
  });
}

/**
 * Purchase a subscription.
 */
export async function purchaseSubscription(
  sku: SubscriptionSku,
): Promise<void> {
  // Payment bypassed (dev): simulate an instant successful purchase so the
  // paywall flow completes without Play Billing or a real charge.
  if (!requiresPayment()) return;

  const productId = SKU_MAP[sku];
  // Must query with type: "subs" — Play returns nothing for a subscription
  // product id under the default "in-app" query, which previously made every
  // purchase throw "Subscription product not found".
  const products = await fetchProducts({ skus: [productId], type: "subs" });

  if (!products || products.length === 0) {
    throw new Error("Subscription product not found");
  }

  const offerToken =
    (products[0] as any).subscriptionOfferDetails?.[0]?.offerToken ?? undefined;

  await requestPurchase({
    type: "subs",
    request: {
      google: {
        skus: [productId],
        subscriptionOffers: offerToken
          ? [{ sku: productId, offerToken }]
          : null,
      },
    },
  });
}

/**
 * Fetch the current localized subscription prices from Play. The paywall and
 * settings screen show these instead of hardcoded strings so the user always
 * sees the real, locale/currency-correct price. Best-effort: on any failure
 * (or dev bypass) returns an empty object and the caller falls back to its
 * default copy.
 */
export async function getSubscriptionPrices(): Promise<SubscriptionPrices> {
  if (!requiresPayment()) return {};

  try {
    const products = await fetchProducts({
      skus: [SKU_MAP.monthly_499, SKU_MAP.yearly_3999],
      type: "subs",
    });

    const priceById: Record<string, string> = {};
    for (const p of products ?? []) {
      const id = (p as any).id ?? (p as any).productId;
      const price = (p as any).displayPrice ?? (p as any).localizedPrice;
      if (id && price) priceById[id] = price;
    }

    return {
      monthly: priceById[SKU_MAP.monthly_499],
      yearly: priceById[SKU_MAP.yearly_3999],
    };
  } catch (err) {
    console.warn("[Billing] Failed to fetch subscription prices:", err);
    return {};
  }
}

/**
 * Restore a previously-purchased subscription. Reads the device's owned
 * purchases and re-verifies any of ours with the backend so a reinstalled /
 * re-signed-in user gets their entitlement back. Returns true if at least one
 * of our subscriptions was found and re-verified.
 *
 * Dev bypass: no-op, returns true (the dev user is always "subscribed").
 * The caller should refresh the trial store afterwards to pick up the change.
 */
export async function restorePurchases(): Promise<boolean> {
  if (!requiresPayment()) return true;

  try {
    const purchases = await getAvailablePurchases();
    const ours = (purchases ?? []).filter((p: any) =>
      KNOWN_SUB_PRODUCT_IDS.includes(p.productId),
    );

    let restored = false;
    for (const p of ours) {
      const purchaseToken = (p as any).purchaseToken;
      const productId = (p as any).productId;
      if (!purchaseToken || !productId) continue;
      try {
        const callable = functions().httpsCallable("verifyPurchase");
        await callable({ purchaseToken, productId });
        restored = true;
      } catch (err) {
        console.warn("[Billing] verifyPurchase during restore failed:", err);
      }
    }
    return restored;
  } catch (err) {
    console.error("[Billing] restorePurchases failed:", err);
    return false;
  }
}

/**
 * Open the Google Play subscription-management screen for this app (where the
 * user cancels / changes plan — Play policy requires this be reachable, and
 * cancellation is owned by Play, never by us). Deep-links to the specific
 * subscription when a sku is known, else the subscriptions list.
 */
export async function openManageSubscriptions(
  sku?: SubscriptionSku,
): Promise<void> {
  const pkg =
    (Constants.expoConfig as any)?.android?.package ??
    "com.anonymous.RealtimeApiOnMobile";
  const productId = sku ? SKU_MAP[sku] : undefined;
  const url = productId
    ? `https://play.google.com/store/account/subscriptions?sku=${productId}&package=${pkg}`
    : "https://play.google.com/store/account/subscriptions";
  await Linking.openURL(url);
}

/**
 * Cleanup billing listeners.
 */
export function cleanupBilling(): void {
  purchaseUpdateSubscription?.remove();
  purchaseErrorSubscription?.remove();
  purchaseUpdateSubscription = null;
  purchaseErrorSubscription = null;
}
