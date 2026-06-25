import { create } from "zustand";
import {
  onAuthStateChanged,
  type AppUser,
  FAKE_DEV_USER,
} from "../services/authService";
import { authBypassed } from "../config/env";

interface AuthState {
  user: AppUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

// Start the listener at module load time so the first component that reads
// the store never sees a stale `isLoading: true` flash in bypass mode.
// In bypass mode: onAuthStateChanged fires synchronously with FAKE_DEV_USER,
// so the initial state is correct before any React render.
// In real mode: Firebase is async; `isLoading` stays true until it fires.
export const useAuthStore = create<AuthState>((set) => {
  const isBypass = authBypassed();

  onAuthStateChanged((user) => {
    set({ user, isLoading: false, isAuthenticated: !!user });
  });

  return {
    user: isBypass ? FAKE_DEV_USER : null,
    isLoading: !isBypass,
    isAuthenticated: isBypass,
  };
});
