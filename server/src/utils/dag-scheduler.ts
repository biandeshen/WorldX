export interface TaskNode<T> {
  id: string;
  deps: string[];
  run: () => Promise<T>;
}

export interface ExecutionResult<T> {
  id: string;
  success: boolean;
  data?: T;
  error?: Error;
}

export class DAGScheduler<T> {
  private results = new Map<string, ExecutionResult<T>>();

  async execute(nodes: TaskNode<T>[]): Promise<Map<string, ExecutionResult<T>>> {
    this.results.clear();
    const pending = new Set<string>(nodes.map((n) => n.id));
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));

    const canExecute = (id: string): boolean => {
      const node = nodeMap.get(id);
      if (!node) return false;
      for (const depId of node.deps) {
        if (!this.results.has(depId)) return false;
        const result = this.results.get(depId);
        if (result && !result.success) return false;
      }
      return true;
    };

    const executeNode = async (node: TaskNode<T>): Promise<void> => {
      for (const depId of node.deps) {
        const depResult = this.results.get(depId);
        if (depResult && !depResult.success) {
          this.results.set(node.id, { id: node.id, success: false, error: new Error(`Dependency ${depId} failed`) });
          return;
        }
      }

      try {
        const data = await node.run();
        this.results.set(node.id, { id: node.id, success: true, data });
      } catch (err) {
        this.results.set(node.id, { id: node.id, success: false, error: err instanceof Error ? err : new Error(String(err)) });
      }
    };

    const maxConcurrency = parseInt(process.env.SIMULATION_MAX_CONCURRENT ?? "10", 10);

    while (pending.size > 0) {
      const readyIds = Array.from(pending).filter(canExecute);
      if (readyIds.length === 0) break;

      const batch = readyIds.slice(0, maxConcurrency);
      batch.forEach((id) => pending.delete(id));

      await Promise.all(batch.map((id) => executeNode(nodeMap.get(id)!)));
    }

    return this.results;
  }

  getResult(id: string): ExecutionResult<T> | undefined {
    return this.results.get(id);
  }

  getSuccessfulResults(): ExecutionResult<T>[] {
    return Array.from(this.results.values()).filter((r) => r.success);
  }
}

export function groupIndependentTasks<T>(tasks: TaskNode<T>[]): TaskNode<T>[][] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const groups: TaskNode<T>[][] = [];
  const assigned = new Set<string>();

  const canAddToGroup = (task: TaskNode<T>, group: TaskNode<T>[]): boolean => {
    return task.deps.every((depId) => group.some((g) => g.id === depId));
  };

  for (const task of tasks) {
    if (assigned.has(task.id)) continue;

    let placed = false;
    for (const group of groups) {
      if (canAddToGroup(task, group)) {
        group.push(task);
        assigned.add(task.id);
        placed = true;
        break;
      }
    }

    if (!placed) {
      groups.push([task]);
      assigned.add(task.id);
    }
  }

  return groups;
}

export async function executeInBatches<T>(
  tasks: TaskNode<T>[],
  batchSize: number = 10,
): Promise<Map<string, ExecutionResult<T>>> {
  const scheduler = new DAGScheduler<T>();
  return scheduler.execute(tasks);
}