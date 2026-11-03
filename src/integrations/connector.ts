/**
 * Future integration connectors (Open Finance, CRM, Frotas, etc.).
 * No real connectors in Fase 2 — only contracts.
 */

export type IntegrationCapability =
  | "read_transactions"
  | "read_balances"
  | "list_leads"
  | "list_vehicles"
  | "read_calendar"
  | "read_email"
  | "read_files";

export type ConnectorContext = {
  workspaceId: string;
  userId: string;
  connectionId: string;
};

export interface IntegrationConnector {
  provider: string;
  capabilities(): IntegrationCapability[];
  /** Never expose raw tokens to callers/LLM */
  isReady(ctx: ConnectorContext): Promise<boolean>;
}

export class OpenFinanceConnectorStub implements IntegrationConnector {
  provider = "open_finance";
  capabilities(): IntegrationCapability[] {
    return ["read_transactions", "read_balances"];
  }
  async isReady() {
    return false;
  }
}

export class MoopeCrmConnectorStub implements IntegrationConnector {
  provider = "moope_crm";
  capabilities(): IntegrationCapability[] {
    return ["list_leads"];
  }
  async isReady() {
    return false;
  }
}

export class MoopeFrotasConnectorStub implements IntegrationConnector {
  provider = "moope_frotas";
  capabilities(): IntegrationCapability[] {
    return ["list_vehicles"];
  }
  async isReady() {
    return false;
  }
}
