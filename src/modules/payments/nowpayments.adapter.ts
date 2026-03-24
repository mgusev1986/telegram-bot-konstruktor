/**
 * NOWPayments API adapter — low-level HTTP client.
 * Uses official API: https://documenter.getpostman.com/view/7907941/S1a32n38
 */
import type { PaymentNetwork } from "@prisma/client";

const PAY_CURRENCY_MAP: Record<string, string> = {
  USDT_TRC20: "usdtbsc",
  USDT_BEP20: "usdtbsc",
  TON: "ton",
  OTHER: "usdtbsc"
};

export interface CreatePaymentParams {
  priceAmount: number;
  priceCurrency: string;
  payCurrency: string;
  orderId: string;
  orderDescription?: string;
  ipnCallbackUrl?: string;
  /** Variant A: fix rate so user pays exactly priceAmount */
  fixedRate?: boolean;
}

export interface CreatePaymentResponse {
  payment_id: number;
  payment_status: string;
  pay_address: string;
  price_amount: number;
  price_currency: string;
  pay_amount: number;
  pay_currency: string;
  order_id?: string;
  order_description?: string;
  outcome_amount?: number;
  outcome_currency?: string;
  created_at?: string;
  updated_at?: string;
}

export interface GetPaymentStatusResponse {
  payment_id: number;
  payment_status: string;
  pay_address: string;
  price_amount: number;
  price_currency: string;
  pay_amount: number;
  pay_currency: string;
  order_id?: string;
  outcome_amount?: number;
  outcome_currency?: string;
}

export class NowPaymentsAdapter {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string
  ) {}

  static payCurrencyFromNetwork(network: PaymentNetwork): string {
    return PAY_CURRENCY_MAP[network] ?? "usdtbsc";
  }

  async createPayment(params: CreatePaymentParams): Promise<CreatePaymentResponse> {
    const body = {
      price_amount: params.priceAmount,
      price_currency: params.priceCurrency.toLowerCase(),
      pay_currency: params.payCurrency.toLowerCase(),
      order_id: params.orderId,
      order_description: params.orderDescription ?? undefined,
      ipn_callback_url: params.ipnCallbackUrl ?? undefined,
      fixed_rate: params.fixedRate ?? true
    };

    const res = await fetch(`${this.baseUrl}/payment`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NOWPayments createPayment failed: ${res.status} ${errText}`);
    }

    return res.json() as Promise<CreatePaymentResponse>;
  }

  async getPaymentStatus(paymentId: string): Promise<GetPaymentStatusResponse> {
    const res = await fetch(`${this.baseUrl}/payment/${paymentId}`, {
      headers: {
        "x-api-key": this.apiKey
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`NOWPayments getPaymentStatus failed: ${res.status} ${errText}`);
    }

    return res.json() as Promise<GetPaymentStatusResponse>;
  }

  /**
   * Verify IPN signature per NOWPayments docs:
   * HMAC-SHA512(sorted_body, IPN_SECRET) === x-nowpayments-sig
   */
  static async verifyIpnSignature(
    rawBody: string,
    signature: string | undefined,
    ipnSecret: string
  ): Promise<boolean> {
    if (!signature || !ipnSecret) return false;
    try {
      const crypto = await import("node:crypto");
      const sorted = sortJsonKeysForIpn(rawBody);
      const expected = crypto.createHmac("sha512", ipnSecret).update(sorted).digest("hex");
      return crypto.timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
    } catch {
      return false;
    }
  }
}

/**
 * Sort JSON object keys alphabetically and stringify — required for IPN verification.
 */
function sortJsonKeysForIpn(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return JSON.stringify(sorted);
  } catch {
    return raw;
  }
}
