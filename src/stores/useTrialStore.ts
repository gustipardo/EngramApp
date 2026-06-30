import { create } from "zustand";
import { checkTrialStatus, type TrialStatus } from "../services/trialService";

interface TrialState {
  status: TrialStatus | null;
  isChecking: boolean;
  /** Set when the last refresh threw — lets the UI show a retry instead of
   *  spinning forever on a null status (see settings plan card). */
  error: boolean;
  refresh: () => Promise<void>;
}

export const useTrialStore = create<TrialState>((set) => ({
  status: null,
  isChecking: false,
  error: false,
  refresh: async () => {
    set({ isChecking: true, error: false });
    try {
      const status = await checkTrialStatus();
      set({ status, isChecking: false, error: false });
    } catch (err) {
      console.warn("[trial] checkTrialStatus failed", err);
      set({ isChecking: false, error: true });
    }
  },
}));
