import { create } from "zustand";
import { checkTrialStatus, type TrialStatus } from "../services/trialService";

interface TrialState {
  status: TrialStatus | null;
  isChecking: boolean;
  refresh: () => Promise<void>;
}

export const useTrialStore = create<TrialState>((set) => ({
  status: null,
  isChecking: false,
  refresh: async () => {
    set({ isChecking: true });
    try {
      const status = await checkTrialStatus();
      set({ status, isChecking: false });
    } catch (err) {
      console.warn("[trial] checkTrialStatus failed", err);
      set({ isChecking: false });
    }
  },
}));
