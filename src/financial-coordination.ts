export type FinancialCoordinator = <T>(
  sessions: string[],
  work: () => Promise<T>
) => Promise<T>
export type SessionOrderAssociation = {
  session_id: string
  order_id: string | null
}
export type FinancialCoordinationDependencies = {
  resolve: (sessions: string[]) => Promise<SessionOrderAssociation[]>
  execute: <T>(keys: string[], work: () => Promise<T>) => Promise<T>
}

/** Trusted server resolver and shared distributed locking are supplied by the app. */
export function createRazorpayCoordinator(
  dependencies: FinancialCoordinationDependencies
): FinancialCoordinator {
  const associations = async (sessions: string[]) => {
    const rows = await dependencies.resolve([...sessions])
    if (
      rows.length !== sessions.length ||
      new Set(rows.map((row) => row.session_id)).size !== rows.length ||
      rows.some(
        (row) =>
          !sessions.includes(row.session_id) ||
          (row.order_id !== null && !/^order_[A-Za-z0-9]+$/.test(row.order_id))
      )
    )
      throw new Error("Incomplete or invalid financial order association")
    return rows
      .map(({ session_id, order_id }) => ({ session_id, order_id }))
      .sort((a, b) => a.session_id.localeCompare(b.session_id))
  }
  return async (input, work) => {
    const sessions = [...new Set(input)].sort()
    if (
      !sessions.length ||
      sessions.some((id) => !/^payses_[A-Za-z0-9]+$/.test(id))
    )
      throw new Error("Invalid financial coordination identity")
    const before = await associations(sessions)
    const keys = [
      ...new Set(
        before.flatMap(({ session_id, order_id }) => [
          "razorpay:session:" + session_id,
          ...(order_id ? ["razorpay:order:" + order_id] : []),
        ])
      ),
    ].sort()
    return dependencies.execute(keys, async () => {
      if (
        JSON.stringify(before) !== JSON.stringify(await associations(sessions))
      )
        throw new Error(
          "Financial order association changed; retry coordination"
        )
      return work()
    })
  }
}
