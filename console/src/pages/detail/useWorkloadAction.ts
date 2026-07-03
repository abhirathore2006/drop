// One mutation shape for workload actions: run the API call, invalidate every query under
// the workload trees (list, detail, secrets, backups — keys mirror API paths so the
// prefixes cover them), toast the error. Load errors stay page-level; mutation errors are
// toasts (error taxonomy).
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../components/Toast.tsx";

export function useWorkloadAction(opts?: { onSuccess?: () => void | Promise<void>; success?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/v1/sites"] }),
        qc.invalidateQueries({ queryKey: ["/v1/apps"] }),
        qc.invalidateQueries({ queryKey: ["/v1/databases"] }),
      ]);
      if (opts?.success) toast.success(opts.success);
      await opts?.onSuccess?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });
}
