export type Entity = {
  id: string
  amount: number
  currency: string
  status: string
  order_id?: string
  amount_refunded?: number
  notes?: Record<string, string>
  receipt?: string
}
export interface Gateway {
  request<T>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<T>
}
export class RazorpayGateway implements Gateway {
  constructor(
    private key: string,
    private secret: string
  ) {}
  async request<T>(
    path: string,
    body?: unknown,
    headers: Record<string, string> = {}
  ): Promise<T> {
    const response = await fetch("https://api.razorpay.com/v1/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(this.key + ":" + this.secret).toString("base64"),
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    })
    if (!response.ok)
      throw new Error(
        "Razorpay request failed; reconcile gateway state before retrying"
      )
    return (await response.json()) as T
  }
}
