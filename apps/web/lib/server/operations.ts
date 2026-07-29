import {
  WorkflowOperationsSnapshotSchema,
  type WorkflowOperationsSnapshot,
} from "@mindmark/shared";
import { getSupabaseAdmin } from "./supabase";

export interface OperationsStore {
  loadSnapshot(): Promise<unknown>;
}

export class SupabaseOperationsStore implements OperationsStore {
  async loadSnapshot(): Promise<unknown> {
    const { data, error } = await getSupabaseAdmin().rpc("get_workflow_operations_v2");
    if (error) throw new Error(`Could not load workflow operations: ${error.message}`);
    return data;
  }
}

export async function getWorkflowOperations(
  store: OperationsStore = new SupabaseOperationsStore(),
): Promise<WorkflowOperationsSnapshot> {
  return WorkflowOperationsSnapshotSchema.parse(await store.loadSnapshot());
}
