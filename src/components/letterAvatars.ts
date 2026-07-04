/**
 * Illuminated-manuscript letter avatars (A–Z, 0–9, ? fallback).
 *
 * Hand-generated art (MiniMax, warm-paper illuminated drop-caps in the Engram
 * palette), resized to 160px and bundled in `assets/avatars/`. React Native's
 * bundler needs a *static* `require` per asset, so the map is spelled out.
 *
 * Use `avatarFor(nameOrEmail)` to resolve the correct image from a user's
 * display name / email — same logic that produced the old plain initial.
 */
import type { ImageSourcePropType } from "react-native";

// Static require map — do not convert to a dynamic require (Metro can't resolve those).
const AVATARS: Record<string, ImageSourcePropType> = {
  A: require("../../assets/avatars/A.jpg"),
  B: require("../../assets/avatars/B.jpg"),
  C: require("../../assets/avatars/C.jpg"),
  D: require("../../assets/avatars/D.jpg"),
  E: require("../../assets/avatars/E.jpg"),
  F: require("../../assets/avatars/F.jpg"),
  G: require("../../assets/avatars/G.jpg"),
  H: require("../../assets/avatars/H.jpg"),
  I: require("../../assets/avatars/I.jpg"),
  J: require("../../assets/avatars/J.jpg"),
  K: require("../../assets/avatars/K.jpg"),
  L: require("../../assets/avatars/L.jpg"),
  M: require("../../assets/avatars/M.jpg"),
  N: require("../../assets/avatars/N.jpg"),
  O: require("../../assets/avatars/O.jpg"),
  P: require("../../assets/avatars/P.jpg"),
  Q: require("../../assets/avatars/Q.jpg"),
  R: require("../../assets/avatars/R.jpg"),
  S: require("../../assets/avatars/S.jpg"),
  T: require("../../assets/avatars/T.jpg"),
  U: require("../../assets/avatars/U.jpg"),
  V: require("../../assets/avatars/V.jpg"),
  W: require("../../assets/avatars/W.jpg"),
  X: require("../../assets/avatars/X.jpg"),
  Y: require("../../assets/avatars/Y.jpg"),
  Z: require("../../assets/avatars/Z.jpg"),
  "0": require("../../assets/avatars/0.jpg"),
  "1": require("../../assets/avatars/1.jpg"),
  "2": require("../../assets/avatars/2.jpg"),
  "3": require("../../assets/avatars/3.jpg"),
  "4": require("../../assets/avatars/4.jpg"),
  "5": require("../../assets/avatars/5.jpg"),
  "6": require("../../assets/avatars/6.jpg"),
  "7": require("../../assets/avatars/7.jpg"),
  "8": require("../../assets/avatars/8.jpg"),
  "9": require("../../assets/avatars/9.jpg"),
};

const FALLBACK: ImageSourcePropType = require("../../assets/avatars/_fallback.jpg");

/**
 * Resolve the illuminated avatar for a user identity string.
 * Mirrors the old initial logic: first char of displayName || email, uppercased.
 * Any character without its own art (accents, symbols, empty) → the `?` fallback.
 */
export function avatarFor(nameOrEmail?: string | null): ImageSourcePropType {
  const initial = (nameOrEmail || "?").trim().charAt(0).toUpperCase();
  return AVATARS[initial] ?? FALLBACK;
}
