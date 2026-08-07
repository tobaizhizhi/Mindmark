export class WorkerRewardVerificationError extends Error {
  constructor(
    message: string,
    readonly warningCodes: string[] = [],
  ) {
    super(message);
    this.name = "WorkerRewardVerificationError";
  }
}
