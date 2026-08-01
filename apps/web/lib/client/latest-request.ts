export type LatestRequest = {
  isCurrent: () => boolean;
  commit: (effect: () => void) => boolean;
};

export type LatestRequestGate = {
  begin: () => LatestRequest;
  invalidate: () => void;
};

export function createLatestRequestGate(): LatestRequestGate {
  let generation = 0;

  return {
    begin() {
      const requestGeneration = ++generation;
      const isCurrent = () => requestGeneration === generation;
      return {
        isCurrent,
        commit(effect) {
          if (!isCurrent()) return false;
          effect();
          return true;
        },
      };
    },
    invalidate() {
      generation += 1;
    },
  };
}
