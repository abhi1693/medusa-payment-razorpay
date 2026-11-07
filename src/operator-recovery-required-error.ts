export class OperatorRefundRecoveryRequiredError extends Error {
  constructor() {
    super("Incomplete refund accounting requires controlled operator recovery")
    this.name = "OperatorRefundRecoveryRequiredError"
  }
}
