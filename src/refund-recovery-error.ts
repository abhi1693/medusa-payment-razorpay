export class PendingRefundRecoveryError extends Error {
  constructor() {
    super(
      "Native refund reservation is still in progress; retry the same verified operation later"
    )
    this.name = "PendingRefundRecoveryError"
  }
}
