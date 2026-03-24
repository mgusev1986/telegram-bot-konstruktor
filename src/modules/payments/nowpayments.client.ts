/**
 * NOWPayments API client — top-up, IPN verification, mass payout.
 * Extends adapter with payout methods. Does not log secrets.
 */
import type { PaymentNetwork } from "@prisma/client";
import { NowPaymentsAdapter } from "./nowpayments.adapter";
import type {
  CreatePaymentParams,
  CreatePaymentResponse,
  GetPaymentStatusResponse
} from "./nowpayments.adapter";
import { logger } from "../../common/logger";
import { env } from "../../config/env";

/** Create client from env. Returns null if API key not set. */
export function createNowPaymentsClientFromEnv(): NowPaymentsClient | null {
  const apiKey = env.NOWPAYMENTS_API_KEY?.trim();
  if (!apiKey) return null;
  return new NowPaymentsClient({
    apiKey,
    baseUrl: env.NOWPAYMENTS_BASE_URL,
    email: env.NOWPAYMENTS_EMAIL?.trim() || undefined,
    password: env.NOWPAYMENTS_PASSWORD?.trim() || undefined
  });
}

const PAY_CURRENCY_MAP: Record<string, string> = {
  USDT_TRC20: "usdtbsc",
  USDT_BEP20: "usdtbsc",
  TON: "ton",
  OTHER: "usdtbsc"
};

/** Single withdrawal in a batch */
export interface PayoutWithdrawal {
  address: string;
  currency: string;
  amount: number;
  extraId?: string;
}

/** Request for mass payout batch */
export interface CreateMassPayoutParams {
  withdrawals: PayoutWithdrawal[];
}

/** Single withdrawal in API response */
export interface PayoutWithdrawalResult {
  id?: number;
  address: string;
  currency: string;
  amount: number;
  batchWithdrawalId?: number;
  status: string;
  extraId?: string;
  hash?: string;
  error?: string;
  createdAt?: string;
  requestedAt?: string;
  updatedAt?: string;
}

/** Response from create mass payout */
export interface CreateMassPayoutResponse {
  id: string;
  withdrawals: PayoutWithdrawalResult[];
}

/** Response from get payout status */
export interface GetPayoutBatchStatusResponse {
  id: string;
  createdAt: string;
  withdrawals: PayoutWithdrawalResult[];
}

/** Thrown when payout API is not configured (email/password missing) */
export class NowPaymentsPayoutNotConfiguredError extends Error {
  constructor() {
    super("NOWPayments payout not configured: NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD required");
    this.name = "NowPaymentsPayoutNotConfiguredError";
  }
}

/** Thrown when provider API returns error */
export class NowPaymentsProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly providerCode?: string
  ) {
    super(message);
    this.name = "NowPaymentsProviderError";
  }
}

export class NowPaymentsClient {
  private readonly adapter: NowPaymentsAdapter;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private authToken: string | null = null;
  private authTokenExpiry: number = 0;
  private readonly email?: string;
  private readonly password?: string;

  constructor(options: {
    apiKey: string;
    baseUrl: string;
    email?: string;
    password?: string;
  }) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.adapter = new NowPaymentsAdapter(options.apiKey, this.baseUrl);
    this.email = options.email?.trim() || undefined;
    this.password = options.password?.trim() || undefined;
  }

  static payCurrencyFromNetwork(network: PaymentNetwork): string {
    return PAY_CURRENCY_MAP[network] ?? "usdtbsc";
  }

  /** Create top-up payment (delegates to adapter) */
  async createTopupPayment(params: CreatePaymentParams): Promise<CreatePaymentResponse> {
    return this.adapter.createPayment(params);
  }

  /** Get payment status (delegates to adapter) */
  async getPaymentStatus(paymentId: string): Promise<GetPaymentStatusResponse> {
    return this.adapter.getPaymentStatus(paymentId);
  }

  /** Verify IPN signature (static, delegates to adapter) */
  static async verifyIpnSignature(
    rawBody: string,
    signature: string | undefined,
    ipnSecret: string
  ): Promise<boolean> {
    return NowPaymentsAdapter.verifyIpnSignature(rawBody, signature, ipnSecret);
  }

  /** Ensure we have a valid auth token for payout API (Mass Payouts requires Bearer token) */
  private async ensureAuthToken(): Promise<string> {
    const now = Date.now();
    if (this.authToken && this.authTokenExpiry > now + 60_000) {
      return this.authToken;
    }
    if (!this.email || !this.password) {
      throw new NowPaymentsPayoutNotConfiguredError();
    }
    const res = await fetch(`${this.baseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.email, password: this.password })
    });
    if (!res.ok) {
      const errText = await res.text();
      logger.warn(
        { status: res.status, provider: "nowpayments", path: "/auth" },
        "NOWPayments auth failed (do not log credentials)"
      );
      throw new NowPaymentsProviderError(
        `NOWPayments auth failed: ${res.status}`,
        res.status,
        errText.slice(0, 100)
      );
    }
    const data = (await res.json()) as { token?: string };
    const token = data?.token;
    if (!token || typeof token !== "string") {
      throw new NowPaymentsProviderError("NOWPayments auth: no token in response");
    }
    this.authToken = token;
    this.authTokenExpiry = now + 55 * 60 * 1000; // 55 min
    return token;
  }

  /**
   * Create mass payout batch.
   * Requires NOWPAYMENTS_EMAIL and NOWPAYMENTS_PASSWORD (Mass Payouts API uses Bearer auth).
   */
  async createMassPayoutBatch(params: CreateMassPayoutParams): Promise<CreateMassPayoutResponse> {
    const token = await this.ensureAuthToken();
    const withdrawals = params.withdrawals.map((w) => ({
      address: w.address,
      currency: w.currency.toLowerCase(),
      amount: Number(w.amount.toFixed(6)),
      ...(w.extraId ? { extraId: w.extraId } : {})
    }));

    const res = await fetch(`${this.baseUrl}/payout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ withdrawals })
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(
        { status: res.status, provider: "nowpayments", path: "/payout", count: withdrawals.length },
        "NOWPayments createMassPayoutBatch failed"
      );
      throw new NowPaymentsProviderError(
        `NOWPayments payout failed: ${res.status} ${errText.slice(0, 200)}`,
        res.status
      );
    }

    const data = (await res.json()) as CreateMassPayoutResponse;
    logger.info(
      { provider: "nowpayments", batchId: data?.id, count: data?.withdrawals?.length ?? 0 },
      "NOWPayments mass payout created"
    );
    return data;
  }

  /**
   * Get payout batch status.
   */
  async getPayoutBatchStatus(batchId: string): Promise<GetPayoutBatchStatusResponse> {
    const res = await fetch(`${this.baseUrl}/payout/${encodeURIComponent(batchId)}`, {
      headers: {
        "x-api-key": this.apiKey
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.warn(
        { provider: "nowpayments", batchId, status: res.status },
        "NOWPayments getPayoutBatchStatus failed"
      );
      throw new NowPaymentsProviderError(
        `NOWPayments getPayoutStatus failed: ${res.status} ${errText.slice(0, 100)}`,
        res.status
      );
    }

    return res.json() as Promise<GetPayoutBatchStatusResponse>;
  }
}
